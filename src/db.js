import { AsyncLocalStorage } from "node:async_hooks";
import { readdirSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { log } from "./logger.js";

const txStore = new AsyncLocalStorage();
let base = null;

export function openDb(database) {
  const options = {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  };
  if (database.ssl !== undefined) options.ssl = database.ssl;
  if (database.search_path) {
    options.connection = { search_path: database.search_path };
  }
  if (database.connectionString) {
    return postgres(database.connectionString, options);
  }
  return postgres(
    {
      host: database.host,
      port: database.port,
      database: database.database,
      username: database.user,
      password: database.password,
    },
    options,
  );
}

export async function createSchema(db) {
  await db.begin(async (tx) => {
    await tx.unsafe(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        namespace TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'normal',
        trusted INTEGER NOT NULL DEFAULT 0,
        tos_accepted_at TEXT DEFAULT '',
        tos_version TEXT DEFAULT '',
        privacy_accepted_at TEXT DEFAULT '',
        privacy_version TEXT DEFAULT ''
      );
    `);
    await tx.unsafe(`
      CREATE TABLE auth_tokens (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);
    await tx.unsafe(`
      CREATE TABLE automation_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
    `);
    await tx.unsafe(`
      CREATE TABLE versions (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER NOT NULL REFERENCES users(id),
        package_id TEXT NOT NULL,
        version TEXT NOT NULL,
        status TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        blob_path TEXT NOT NULL,
        downloads INTEGER NOT NULL DEFAULT 0,
        yanked INTEGER NOT NULL DEFAULT 0,
        yank_reason TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT,
        UNIQUE(owner_id, package_id, version)
      );
    `);
    await tx.unsafe(`
      CREATE UNIQUE INDEX versions_one_pending_per_owner_package
        ON versions(owner_id, package_id) WHERE status IN ('staging', 'pending');
    `);
    await tx.unsafe(`
      CREATE INDEX versions_status ON versions(status);
    `);
    await tx.unsafe(`
      CREATE INDEX versions_status_id ON versions(status, id DESC);
    `);
    await tx.unsafe(`
      CREATE TABLE notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        package_id TEXT,
        version TEXT,
        read_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
    await tx.unsafe(`
      CREATE INDEX notifications_user_id ON notifications(user_id);
    `);
    await tx.unsafe(`
      CREATE INDEX notifications_user_id_id ON notifications(user_id, id DESC);
    `);
    await tx.unsafe(`
      CREATE INDEX auth_tokens_user_id ON auth_tokens(user_id);
    `);
    await tx.unsafe(`
      CREATE TABLE webhooks (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        events TEXT NOT NULL,
        secret_encrypted TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );
    `);
  });
}

export function blobPath(dataDir, owner, packageId, version) {
  return join(dataDir, "blobs", owner, packageId, `${version}.js`);
}

export const STAGING_SUFFIX = ".staging-";

export function stagingBlobPath(dataDir, owner, packageId, version, nonce) {
  return join(
    dataDir,
    "blobs",
    owner,
    packageId,
    `${version}${STAGING_SUFFIX}${nonce}`,
  );
}

export async function reconcileStaging(db) {
  const staging = await db.unsafe(
    "SELECT id, owner_id, package_id, version, blob_path, status FROM versions WHERE status IN ('staging', 'pending_delete')",
  );
  for (const row of staging) {
    if (row.status === "staging") {
      if (existsSync(row.blob_path)) {
        await db.unsafe(
          "UPDATE versions SET status = 'pending' WHERE id = $1",
          [row.id],
        );
        log.info(
          `Promoted staging version ${row.package_id}@${row.version} to pending`,
        );
      } else {
        await db.unsafe("DELETE FROM versions WHERE id = $1", [row.id]);
        log.warn(
          `Deleted orphaned staging version ${row.package_id}@${row.version} (no blob)`,
        );
      }
    } else {
      try {
        // Unlink before deleting on purpose: if the server dies between the
        // two, the pending_delete row survives and the next sweep removes it
        // once the blob reads as absent.
        if (existsSync(row.blob_path)) unlinkSync(row.blob_path);
        await db.unsafe("DELETE FROM versions WHERE id = $1", [row.id]);
        log.warn(
          `Finalized pending-delete version ${row.package_id}@${row.version}`,
        );
      } catch (err) {
        log.warn(
          `Blob still locked for ${row.blob_path}, keeping ${row.package_id}@${row.version} for retry: ${err.message}`,
        );
      }
    }
  }
}

export function cleanupTempBlobs(dataDir) {
  const blobsDir = join(dataDir, "blobs");
  if (!existsSync(blobsDir)) return;

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.startsWith(".tmp-") ||
        entry.name.includes(STAGING_SUFFIX)
      ) {
        try {
          unlinkSync(full);
          log.debug(`Cleaned up temp blob: ${full}`);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(blobsDir);
}

const stmts = {};

function conn() {
  const store = txStore.getStore();
  return (store && store.tx) || base;
}

async function exec(kind, sql, args) {
  const rows = await conn().unsafe(sql, args);
  if (kind === "run") return { changes: Number(rows.count ?? 0) };
  if (kind === "get") return rows[0];
  return rows;
}

function defineStatement(sql) {
  return {
    sql,
    run: (...args) => exec("run", sql, args),
    get: (...args) => exec("get", sql, args),
    all: (...args) => exec("all", sql, args),
  };
}

export function prepare(db) {
  base = db;
  const s = (name, sql) => {
    stmts[name] = defineStatement(sql);
  };

  // Users
  s("getUserByNamespace", "SELECT * FROM users WHERE namespace = $1");
  s("getUserById", "SELECT * FROM users WHERE id = $1");
  s(
    "createUser",
    "INSERT INTO users (namespace, display_name, password_hash, type, trusted) VALUES ($1, $2, $3, $4, $5) RETURNING *",
  );
  s(
    "updateUserDisplayName",
    "UPDATE users SET display_name = $1 WHERE namespace = $2 RETURNING *",
  );
  s(
    "updateUserPassword",
    "UPDATE users SET password_hash = $1 WHERE namespace = $2 RETURNING *",
  );
  s(
    "updateUserRole",
    "UPDATE users SET type = $1 WHERE namespace = $2 RETURNING *",
  );
  s(
    "updateUserTrust",
    "UPDATE users SET trusted = $1 WHERE namespace = $2 RETURNING *",
  );
  s(
    "updateUserTermsAcceptance",
    "UPDATE users SET tos_accepted_at = $1, tos_version = $2, privacy_accepted_at = $3, privacy_version = $4 WHERE id = $5 RETURNING *",
  );
  s("listUsers", "SELECT * FROM users WHERE id > $1 ORDER BY id ASC LIMIT $2");
  s("countUsers", "SELECT COUNT(*)::int as count FROM users");
  s(
    "countAdminsForUpdate",
    "SELECT COUNT(*)::int as count FROM (SELECT id FROM users WHERE type = 'admin' FOR UPDATE) AS admins",
  );
  s(
    "lockSignupFirstAdmin",
    "SELECT pg_advisory_xact_lock(hashtext('fluorite-signup')::bigint)",
  );

  // Auth tokens
  s(
    "createAuthToken",
    "INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at) VALUES ($1, $2, $3, $4)",
  );
  s("getAuthToken", "SELECT * FROM auth_tokens WHERE token_hash = $1");
  s("deleteAuthToken", "DELETE FROM auth_tokens WHERE id = $1");
  s("deleteAllAuthTokens", "DELETE FROM auth_tokens WHERE user_id = $1");
  s(
    "listAuthTokens",
    "SELECT * FROM auth_tokens WHERE user_id = $1 AND expires_at::timestamptz > now()",
  );
  s("deleteExpiredAuthTokens", "DELETE FROM auth_tokens WHERE expires_at < $1");

  // Automation tokens
  s(
    "createAutomationToken",
    "INSERT INTO automation_tokens (id, user_id, name, token_hash, scopes, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
  );
  s(
    "getAutomationToken",
    "SELECT * FROM automation_tokens WHERE token_hash = $1",
  );
  s(
    "deleteAutomationToken",
    "DELETE FROM automation_tokens WHERE id = $1 AND user_id = $2",
  );
  s(
    "deleteAllAutomationTokens",
    "DELETE FROM automation_tokens WHERE user_id = $1",
  );
  s(
    "listAutomationTokens",
    "SELECT * FROM automation_tokens WHERE user_id = $1",
  );
  s(
    "updateAutomationTokenLastUsed",
    "UPDATE automation_tokens SET last_used_at = $1 WHERE id = $2",
  );

  // Versions
  s(
    "createVersion",
    `INSERT INTO versions (owner_id, package_id, version, status, meta_json, blob_path, created_at, published_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
  );
  s(
    "getVersion",
    "SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id WHERE u.namespace = $1 AND v.package_id = $2 AND v.version = $3",
  );
  s(
    "getVersionById",
    "SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id WHERE v.id = $1",
  );
  s(
    "getVersionByOwnerPackageVersion",
    "SELECT * FROM versions WHERE owner_id = $1 AND package_id = $2 AND version = $3",
  );
  s(
    "resolveLatestVersion",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = $1 AND v.package_id = $2 AND v.status = 'published' AND v.yanked = 0`,
  );
  s(
    "updateVersionStatus",
    "UPDATE versions SET status = $1, published_at = $2 WHERE id = $3 RETURNING *",
  );
  s(
    "finalizeVersion",
    "UPDATE versions SET status = $1, published_at = $2, blob_path = $3 WHERE id = $4 RETURNING *",
  );
  s(
    "updateVersionYank",
    "UPDATE versions SET yanked = $1, yank_reason = $2 WHERE id = $3 RETURNING *",
  );
  s("deleteVersion", "DELETE FROM versions WHERE id = $1");
  s(
    "markVersionDeletionPending",
    "UPDATE versions SET status = 'pending_delete' WHERE id = $1",
  );
  s(
    "incrementDownloads",
    "UPDATE versions SET downloads = downloads + 1 WHERE id = $1",
  );
  s(
    "hasPendingVersion",
    `SELECT 1 FROM versions WHERE owner_id = $1 AND status IN ('staging', 'pending') LIMIT 1`,
  );
  s(
    "lockOwnerPublish",
    "SELECT pg_advisory_xact_lock(hashtext('publish-' || $1)::bigint)",
  );
  s(
    "versionExists",
    "SELECT 1 FROM versions WHERE owner_id = $1 AND package_id = $2 AND version = $3",
  );
  s(
    "highestPublishedVersion",
    `SELECT version FROM versions WHERE owner_id = $1 AND package_id = $2 AND status = 'published' AND yanked = 0`,
  );
  s(
    "listVersionsByOwner",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = $1 AND v.package_id = $2 ORDER BY v.id DESC`,
  );
  s(
    "listVersionsByOwnerListing",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = $1 AND v.package_id = $2
    AND v.status IN ('published', 'pending', 'rejected') ORDER BY v.id DESC`,
  );
  s(
    "listVersionsByExtension",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = $1 AND v.package_id = $2 AND v.status = 'published' AND v.yanked = 0 ORDER BY v.id DESC`,
  );
  s(
    "listVersionsWorklist",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE v.status = $1 AND v.id < $2 ORDER BY v.id DESC LIMIT $3`,
  );
  s(
    "countVersionsByStatus",
    `SELECT COUNT(*)::int as count FROM versions WHERE status = $1`,
  );
  s(
    "deleteVersionsByOwnerAndPackage",
    "DELETE FROM versions WHERE owner_id = $1 AND package_id = $2",
  );
  s("listVersionsByUser", "SELECT * FROM versions WHERE owner_id = $1");

  // Extension identities
  s(
    "listExtensionIdentities",
    `SELECT u.namespace, v.package_id, MAX(v.id) AS sort_key
    FROM versions v
    JOIN users u ON v.owner_id = u.id
    WHERE v.status = 'published' AND v.yanked = 0
    GROUP BY u.namespace, v.package_id
    HAVING MAX(v.id) < $1
    ORDER BY sort_key DESC
    LIMIT $2`,
  );

  s(
    "searchExtensionIdentities",
    `SELECT u.namespace, v.package_id, MAX(v.id) AS sort_key
    FROM versions v
    JOIN users u ON v.owner_id = u.id
    WHERE v.status = 'published' AND v.yanked = 0
    AND (u.namespace ILIKE '%' || $1 || '%' ESCAPE '\\'
      OR v.package_id ILIKE '%' || $2 || '%' ESCAPE '\\'
      OR COALESCE(v.meta_json::jsonb ->> 'name', '') ILIKE '%' || $3 || '%' ESCAPE '\\'
      OR COALESCE(v.meta_json::jsonb ->> 'description', '') ILIKE '%' || $4 || '%' ESCAPE '\\')
    GROUP BY u.namespace, v.package_id
    HAVING MAX(v.id) < $5
    ORDER BY sort_key DESC
    LIMIT $6`,
  );

  s(
    "extensionExists",
    `SELECT 1 FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = $1 AND v.package_id = $2 AND v.status = 'published' LIMIT 1`,
  );

  // Notifications
  s(
    "createNotification",
    "INSERT INTO notifications (user_id, message, package_id, version, read_at, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
  );
  s(
    "getNotification",
    "SELECT * FROM notifications WHERE id = $1 AND user_id = $2",
  );
  s(
    "listNotifications",
    "SELECT * FROM notifications WHERE user_id = $1 AND id < $2 ORDER BY id DESC LIMIT $3",
  );
  s(
    "listNotificationsRead",
    "SELECT * FROM notifications WHERE user_id = $1 AND read_at IS NOT NULL AND id < $2 ORDER BY id DESC LIMIT $3",
  );
  s(
    "listNotificationsUnread",
    "SELECT * FROM notifications WHERE user_id = $1 AND read_at IS NULL AND id < $2 ORDER BY id DESC LIMIT $3",
  );
  s(
    "markNotificationRead",
    "UPDATE notifications SET read_at = $1 WHERE id = $2 AND read_at IS NULL RETURNING *",
  );
  s("deleteNotification", "DELETE FROM notifications WHERE id = $1");
  s(
    "deleteReadNotifications",
    "DELETE FROM notifications WHERE user_id = $1 AND read_at IS NOT NULL",
  );
  s(
    "countUnreadNotifications",
    "SELECT COUNT(*)::int as count FROM notifications WHERE user_id = $1 AND read_at IS NULL",
  );

  // Webhooks
  s(
    "createWebhook",
    "INSERT INTO webhooks (id, url, events, secret_encrypted, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *",
  );
  s("getWebhook", "SELECT * FROM webhooks WHERE id = $1");
  s(
    "listWebhooks",
    "SELECT id, url, events, enabled, created_at FROM webhooks ORDER BY created_at DESC",
  );
  s(
    "listEnabledWebhooksForEvent",
    "SELECT * FROM webhooks WHERE enabled = 1 AND events::jsonb @> $1::jsonb",
  );
  s(
    "updateWebhook",
    "UPDATE webhooks SET url = $1, events = $2, enabled = $3 WHERE id = $4 RETURNING *",
  );
  s("deleteWebhook", "DELETE FROM webhooks WHERE id = $1");

  // Stats
  s(
    "stats",
    `SELECT
    (SELECT COUNT(*)::int FROM (SELECT DISTINCT owner_id, package_id FROM versions WHERE status = 'published' AND yanked = 0) AS published_versions) as published,
    (SELECT COUNT(*)::int FROM versions WHERE status = 'pending') as pending,
    (SELECT COUNT(DISTINCT owner_id)::int FROM versions WHERE status = 'published' AND yanked = 0) as authors,
    (SELECT COALESCE(SUM(downloads), 0)::int FROM versions WHERE status = 'published' AND yanked = 0) as "totalDownloads"`,
  );

  // Terms document publishing
  s("lockTermsDir", "SELECT pg_advisory_lock(hashtext($1)::bigint)");
  s("unlockTermsDir", "SELECT pg_advisory_unlock(hashtext($1)::bigint)");

  return stmts;
}

export function getStmt(name) {
  return stmts[name];
}

export function listVersionsByExtensionBatched(pairs) {
  if (!pairs.length) return [];
  const clauses = pairs.map(
    (_, i) => `(u.namespace = $${i * 2 + 1} AND v.package_id = $${i * 2 + 2})`,
  );
  const args = pairs.flatMap((p) => [p.namespace, p.package_id]);
  return conn().unsafe(
    `SELECT v.*, u.namespace FROM versions v
    JOIN users u ON v.owner_id = u.id
    WHERE (${clauses.join(" OR ")}) AND v.status = 'published' AND v.yanked = 0
    ORDER BY v.id DESC`,
    args,
  );
}

export async function runTransaction(fn) {
  if (txStore.getStore()) {
    await fn();
    return;
  }
  await base.begin(async (tx) => {
    await txStore.run({ tx }, async () => {
      await fn();
    });
  });
}

export async function deleteUserCascade(id) {
  const collected = [];
  let missing = false;
  await runTransaction(async () => {
    await conn().unsafe("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    const target = await getStmt("getUserById").get(id);
    if (!target) {
      missing = true;
      return;
    }
    if (target.type === "admin") {
      const { count } = await getStmt("countAdminsForUpdate").get();
      if (count <= 1) {
        const err = new Error("Cannot delete the only remaining admin.");
        err.code = "LAST_ADMIN";
        throw err;
      }
    }
    const versions = await getStmt("listVersionsByUser").all(id);
    for (const v of versions) collected.push(v);
  });
  if (missing) return { missing: true };

  let pending = false;
  for (const v of collected) {
    if (!v.blob_path || !existsSync(v.blob_path)) continue;
    try {
      unlinkSync(v.blob_path);
    } catch (err) {
      pending = true;
      log.warn(
        `Failed to delete blob ${v.blob_path}, left pending for retry: ${err.message}`,
      );
      await getStmt("markVersionDeletionPending").run(v.id);
    }
  }
  if (pending) return { pending: true };

  await runTransaction(async () => {
    const known = new Set(collected.map((v) => v.id));
    const versions = await getStmt("listVersionsByUser").all(id);
    const incoming = versions.filter((v) => !known.has(v.id));
    if (incoming.length) {
      pending = true;
      for (const v of incoming) {
        await getStmt("markVersionDeletionPending").run(v.id);
      }
      return;
    }
    for (const v of versions) await getStmt("deleteVersion").run(v.id);
    await conn().unsafe("DELETE FROM users WHERE id = $1", [id]);
  });

  return { pending };
}
