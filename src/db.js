import Database from "better-sqlite3";
import { mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { log } from "./logger.js";

export function openDb(dbPath) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      namespace TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL DEFAULT 'normal',
      trusted INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS automation_tokens (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );

    CREATE TABLE IF NOT EXISTS versions (
      id INTEGER PRIMARY KEY,
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

    CREATE UNIQUE INDEX IF NOT EXISTS versions_one_pending_per_owner
      ON versions(owner_id) WHERE status IN ('staging', 'pending');

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      package_id TEXT,
      version TEXT,
      read_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      secret_hash TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
}

export function blobPath(dataDir, owner, packageId, version) {
  return join(dataDir, "blobs", owner, packageId, `${version}.js`);
}

export function reconcileStaging(db, dataDir) {
  const staging = db
    .prepare(
      "SELECT id, owner_id, package_id, version, blob_path FROM versions WHERE status = 'staging'",
    )
    .all();
  for (const row of staging) {
    if (existsSync(row.blob_path)) {
      db.prepare("UPDATE versions SET status = 'pending' WHERE id = ?").run(
        row.id,
      );
      log.info(
        `Promoted staging version ${row.package_id}@${row.version} to pending`,
      );
    } else {
      db.prepare("DELETE FROM versions WHERE id = ?").run(row.id);
      log.warn(
        `Deleted orphaned staging version ${row.package_id}@${row.version} (no blob)`,
      );
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
      } else if (entry.name.startsWith(".tmp-")) {
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

export function prepare(db) {
  const s = (name, sql) => {
    stmts[name] = db.prepare(sql);
  };

  // Users
  s("getUserByNamespace", "SELECT * FROM users WHERE namespace = ?");
  s("getUserById", "SELECT * FROM users WHERE id = ?");
  s(
    "createUser",
    "INSERT INTO users (namespace, display_name, password_hash, type, trusted) VALUES (?, ?, ?, ?, ?) RETURNING *",
  );
  s(
    "updateUserDisplayName",
    "UPDATE users SET display_name = ? WHERE namespace = ? RETURNING *",
  );
  s(
    "updateUserPassword",
    "UPDATE users SET password_hash = ? WHERE namespace = ? RETURNING *",
  );
  s(
    "updateUserRole",
    "UPDATE users SET type = ? WHERE namespace = ? RETURNING *",
  );
  s(
    "updateUserTrust",
    "UPDATE users SET trusted = ? WHERE namespace = ? RETURNING *",
  );
  s("deleteUser", "DELETE FROM users WHERE namespace = ?");
  s("listUsers", "SELECT * FROM users ORDER BY id ASC LIMIT ? OFFSET ?");
  s("countUsers", "SELECT COUNT(*) as count FROM users");

  // Auth tokens
  s(
    "createAuthToken",
    "INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
  );
  s("getAuthToken", "SELECT * FROM auth_tokens WHERE token_hash = ?");
  s("deleteAuthToken", "DELETE FROM auth_tokens WHERE id = ?");
  s("deleteAllAuthTokens", "DELETE FROM auth_tokens WHERE user_id = ?");
  s("listAuthTokens", "SELECT * FROM auth_tokens WHERE user_id = ?");
  s("deleteExpiredAuthTokens", "DELETE FROM auth_tokens WHERE expires_at < ?");

  // Automation tokens
  s(
    "createAutomationToken",
    "INSERT INTO automation_tokens (id, user_id, name, token_hash, scopes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  s(
    "getAutomationToken",
    "SELECT * FROM automation_tokens WHERE token_hash = ?",
  );
  s(
    "deleteAutomationToken",
    "DELETE FROM automation_tokens WHERE id = ? AND user_id = ?",
  );
  s(
    "deleteAllAutomationTokens",
    "DELETE FROM automation_tokens WHERE user_id = ?",
  );
  s(
    "listAutomationTokens",
    "SELECT * FROM automation_tokens WHERE user_id = ?",
  );
  s(
    "updateAutomationTokenLastUsed",
    "UPDATE automation_tokens SET last_used_at = ? WHERE id = ?",
  );

  // Versions
  s(
    "createVersion",
    `INSERT INTO versions (owner_id, package_id, version, status, meta_json, blob_path, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  s(
    "getVersion",
    "SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id WHERE u.namespace = ? AND v.package_id = ? AND v.version = ?",
  );
  s(
    "getVersionById",
    "SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id WHERE v.id = ?",
  );
  s(
    "resolveLatestVersion",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = ? AND v.package_id = ? AND v.status = 'published' AND v.yanked = 0
    ORDER BY v.id DESC LIMIT 1`,
  );
  s(
    "updateVersionStatus",
    "UPDATE versions SET status = ?, published_at = ? WHERE id = ? RETURNING *",
  );
  s(
    "updateVersionYank",
    "UPDATE versions SET yanked = ?, yank_reason = ? WHERE id = ? RETURNING *",
  );
  s("deleteVersion", "DELETE FROM versions WHERE id = ?");
  s(
    "incrementDownloads",
    "UPDATE versions SET downloads = downloads + 1 WHERE id = ?",
  );
  s(
    "hasPendingVersion",
    `SELECT 1 FROM versions WHERE owner_id = ? AND status IN ('staging', 'pending') LIMIT 1`,
  );
  s(
    "versionExists",
    "SELECT 1 FROM versions WHERE owner_id = ? AND package_id = ? AND version = ?",
  );
  s(
    "highestPublishedVersion",
    `SELECT version FROM versions WHERE owner_id = ? AND package_id = ? AND status = 'published' ORDER BY id DESC LIMIT 1`,
  );
  s(
    "listVersionsByOwner",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = ? AND v.package_id = ? ORDER BY v.id DESC`,
  );
  s(
    "listVersionsByExtension",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = ? AND v.package_id = ? AND v.status = 'published' ORDER BY v.id DESC`,
  );
  s(
    "listVersionsWorklist",
    `SELECT v.*, u.namespace FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE v.status = ? ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  );
  s(
    "countVersionsByStatus",
    `SELECT COUNT(*) as count FROM versions WHERE status = ?`,
  );
  s(
    "deleteVersionsByOwnerAndPackage",
    "DELETE FROM versions WHERE owner_id = ? AND package_id = ?",
  );

  // Extension summaries
  s(
    "listExtensions",
    `SELECT u.namespace, v.package_id as id,
    json_extract(v.meta_json, '$.name') as name,
    json_extract(v.meta_json, '$.description') as description,
    json_extract(v.meta_json, '$.license') as license,
    v.version as latestVersion,
    v.published_at as publishedAt,
    COALESCE(SUM(v2.downloads), 0) as totalDownloads
    FROM versions v
    JOIN users u ON v.owner_id = u.id
    LEFT JOIN versions v2 ON v2.owner_id = u.id AND v2.package_id = v.package_id AND v2.status = 'published'
    WHERE v.status = 'published' AND v.yanked = 0
    AND v.id = (SELECT MAX(v3.id) FROM versions v3 WHERE v3.owner_id = u.id AND v3.package_id = v.package_id AND v3.status = 'published' AND v3.yanked = 0)
    GROUP BY u.namespace, v.package_id
    ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  );

  s(
    "listExtensionsByOwner",
    `SELECT u.namespace, v.package_id as id,
    json_extract(v.meta_json, '$.name') as name,
    json_extract(v.meta_json, '$.description') as description,
    json_extract(v.meta_json, '$.license') as license,
    v.version as latestVersion,
    v.published_at as publishedAt,
    COALESCE(SUM(v2.downloads), 0) as totalDownloads
    FROM versions v
    JOIN users u ON v.owner_id = u.id
    LEFT JOIN versions v2 ON v2.owner_id = u.id AND v2.package_id = v.package_id AND v2.status = 'published'
    WHERE v.status = 'published' AND v.yanked = 0
    AND v.id = (SELECT MAX(v3.id) FROM versions v3 WHERE v3.owner_id = u.id AND v3.package_id = v.package_id AND v3.status = 'published' AND v3.yanked = 0)
    GROUP BY u.namespace, v.package_id
    ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  );

  s(
    "searchExtensions",
    `SELECT u.namespace, v.package_id as id,
    json_extract(v.meta_json, '$.name') as name,
    json_extract(v.meta_json, '$.description') as description,
    json_extract(v.meta_json, '$.license') as license,
    v.version as latestVersion,
    v.published_at as publishedAt,
    COALESCE(SUM(v2.downloads), 0) as totalDownloads
    FROM versions v
    JOIN users u ON v.owner_id = u.id
    LEFT JOIN versions v2 ON v2.owner_id = u.id AND v2.package_id = v.package_id AND v2.status = 'published'
    WHERE v.status = 'published' AND v.yanked = 0
    AND v.id = (SELECT MAX(v3.id) FROM versions v3 WHERE v3.owner_id = u.id AND v3.package_id = v.package_id AND v3.status = 'published' AND v3.yanked = 0)
    AND (u.namespace LIKE '%' || ? || '%'
      OR v.package_id LIKE '%' || ? || '%'
      OR json_extract(v.meta_json, '$.name') LIKE '%' || ? || '%'
      OR json_extract(v.meta_json, '$.description') LIKE '%' || ? || '%')
    GROUP BY u.namespace, v.package_id
    ORDER BY v.id DESC LIMIT ? OFFSET ?`,
  );

  s(
    "extensionExists",
    `SELECT 1 FROM versions v JOIN users u ON v.owner_id = u.id
    WHERE u.namespace = ? AND v.package_id = ? AND v.status = 'published' LIMIT 1`,
  );

  // Notifications
  s(
    "createNotification",
    "INSERT INTO notifications (user_id, message, package_id, version, read_at, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
  );
  s("getNotification", "SELECT * FROM notifications WHERE id = ?");
  s(
    "listNotifications",
    "SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
  );
  s(
    "listNotificationsByStatus",
    "SELECT * FROM notifications WHERE user_id = ? AND read_at IS ? ORDER BY id DESC LIMIT ? OFFSET ?",
  );
  s(
    "markNotificationRead",
    "UPDATE notifications SET read_at = ? WHERE id = ? RETURNING *",
  );
  s("deleteNotification", "DELETE FROM notifications WHERE id = ?");
  s(
    "deleteReadNotifications",
    "DELETE FROM notifications WHERE user_id = ? AND read_at IS NOT NULL",
  );
  s(
    "countUnreadNotifications",
    "SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read_at IS NULL",
  );

  // Webhooks
  s(
    "createWebhook",
    "INSERT INTO webhooks (id, url, events, secret_hash, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *",
  );
  s("getWebhook", "SELECT * FROM webhooks WHERE id = ?");
  s(
    "listWebhooks",
    "SELECT id, url, events, enabled, created_at FROM webhooks ORDER BY created_at DESC",
  );
  s(
    "listEnabledWebhooksForEvent",
    "SELECT * FROM webhooks WHERE enabled = 1 AND events LIKE ?",
  );
  s(
    "updateWebhook",
    "UPDATE webhooks SET url = ?, events = ?, enabled = ? WHERE id = ? RETURNING *",
  );
  s("deleteWebhook", "DELETE FROM webhooks WHERE id = ?");

  // Stats
  s(
    "stats",
    `SELECT
    (SELECT COUNT(*) FROM versions WHERE status = 'published') as published,
    (SELECT COUNT(*) FROM versions WHERE status = 'pending') as pending,
    (SELECT COUNT(*) FROM users) as authors,
    (SELECT COALESCE(SUM(downloads), 0) FROM versions WHERE status = 'published') as totalDownloads`,
  );

  return stmts;
}

export function getStmt(name) {
  return stmts[name];
}
