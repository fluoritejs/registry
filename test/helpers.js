import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import postgres from "postgres";
import { loadConfig, setConfig, setDeployment } from "../src/config.js";
import { openDb, migrate, prepare, getStmt } from "../src/db.js";
import { createApp } from "../src/app.js";
import { setLevel } from "../src/logger.js";
import { clearRateLimits, hashPassword, nowIso } from "../src/auth.js";
import { loadManifest } from "../src/terms.js";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://fluorite:fluorite@localhost:5432/fluorite";

export async function openTestDb() {
  const schema = `test_${randomUUID().replace(/-/g, "")}`;
  const admin = postgres(TEST_DATABASE_URL, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.end();
  const db = openDb({
    connectionString: TEST_DATABASE_URL,
    search_path: schema,
  });
  return {
    db,
    schema,
    async cleanup() {
      await db.end();
      const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    },
  };
}

export async function createTestEnv(
  deploymentOverrides = {},
  configOverrides = {},
) {
  clearRateLimits();
  const dataDir = mkdtempSync(join(tmpdir(), "fluorite-test-"));
  const termsOverride = configOverrides.terms || {};
  const config = loadConfig({
    ...configOverrides,
    terms: {
      dir: join(dataDir, "terms"),
      enforce: termsOverride.enforce ?? false,
    },
  });
  setConfig(config);
  setLevel("error");

  const termsDir = join(dataDir, "terms");
  mkdirSync(termsDir, { recursive: true });
  writeFileSync(
    join(termsDir, "manifest.yaml"),
    "tosVersion: test-tos\nprivacyVersion: test-privacy\n",
    "utf8",
  );
  writeFileSync(
    join(termsDir, "tos.test-tos.md"),
    "# Test Terms of Service",
    "utf8",
  );
  writeFileSync(
    join(termsDir, "privacy.test-privacy.md"),
    "# Test Privacy Policy",
    "utf8",
  );

  const { db, schema, cleanup: dropSchema } = await openTestDb();
  await migrate(db);
  prepare(db);

  const deployment = {
    server: {
      port: 0,
      publicBaseUrl: "http://localhost",
      requireHttps: false,
      ...deploymentOverrides.server,
    },
    storage: { dataDir, ...deploymentOverrides.storage },
    database: {
      host: "localhost",
      port: 5432,
      database: "fluorite",
      user: "fluorite",
      password: "",
      ...deploymentOverrides.database,
    },
    admin: {
      firstUserBecomesAdmin: true,
      bootstrapAccount: null,
      ...deploymentOverrides.admin,
    },
  };
  setDeployment(deployment);

  if (deployment.admin.bootstrapAccount) {
    const bootstrap = deployment.admin.bootstrapAccount;
    if (!(await getStmt("getUserByNamespace").get(bootstrap.namespace))) {
      const hash = await hashPassword(bootstrap.password);
      await getStmt("createUser").get(
        bootstrap.namespace,
        bootstrap.displayName || "Administrator",
        hash,
        "admin",
        1,
      );
      const created = await getStmt("getUserByNamespace").get(
        bootstrap.namespace,
      );
      const { tosVersion, privacyVersion } = loadManifest(config.terms.dir);
      await getStmt("updateUserTermsAcceptance").run(
        nowIso(),
        tosVersion,
        nowIso(),
        privacyVersion,
        created.id,
      );
    }
  }

  const app = createApp();

  return {
    app,
    db,
    schema,
    dataDir,
    config,
    deployment,
    async cleanup() {
      await dropSchema();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function request(app, method, path, options = {}) {
  const http = await import("node:http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const reqOptions = {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: { ...options.headers },
      };

      if (options.body !== undefined) {
        reqOptions.headers["Content-Type"] =
          options.headers?.["Content-Type"] || "application/json";
      }

      const req = http.request(reqOptions, (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          server.close();
          let body;
          try {
            body = JSON.parse(data);
          } catch {
            body = data;
          }
          resolve({
            status: res.statusCode,
            headers: Object.fromEntries(Object.entries(res.headers)),
            body,
          });
        });
      });

      req.on("error", (err) => {
        server.close();
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error(`Test request to ${method} ${path} timed out`));
      });

      if (options.body !== undefined) {
        req.write(
          typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body),
        );
      }
      req.end();
    });
  });
}

export function signup(app, namespace = "testuser", password = "testpass123") {
  return request(app, "POST", "/v0/auth/signup", {
    body: JSON.stringify({ namespace, password }),
    headers: { "Content-Type": "application/json" },
  });
}

export function login(app, namespace = "testuser", password = "testpass123") {
  return request(app, "POST", "/v0/auth/login", {
    body: JSON.stringify({ namespace, password }),
    headers: { "Content-Type": "application/json" },
  });
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}
