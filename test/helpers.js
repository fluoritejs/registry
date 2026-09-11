import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import express from "express";
import { loadConfig, setConfig, setDeployment } from "../src/config.js";
import { openDb, migrate, prepare, getStmt } from "../src/db.js";
import { setLevel } from "../src/logger.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
  termsMiddleware,
  clearRateLimits,
  hashPassword,
  nowIso,
} from "../src/auth.js";
import { loadManifest } from "../src/terms.js";

import authRoutes from "../src/routes/auth.js";
import userRoutes from "../src/routes/users.js";
import extensionRoutes from "../src/routes/extensions.js";
import versionRoutes from "../src/routes/versions.js";
import webhookRoutes from "../src/routes/webhooks.js";
import notificationRoutes from "../src/routes/notifications.js";
import statsRoutes from "../src/routes/stats.js";
import termsRoutes from "../src/routes/terms.js";

export function createTestEnv(deploymentOverrides = {}, configOverrides = {}) {
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
  writeFileSync(join(termsDir, "tos.md"), "# Test Terms of Service", "utf8");
  writeFileSync(
    join(termsDir, "privacy.md"),
    "# Test Privacy Policy",
    "utf8",
  );

  const dbPath = join(dataDir, "registry.sqlite");
  const db = openDb(dbPath);
  migrate(db);
  prepare(db);

  const deployment = {
    server: { port: 0, publicBaseUrl: "http://localhost", requireHttps: false },
    storage: { dataDir },
    admin: { firstUserBecomesAdmin: true, bootstrapAccount: null },
    ...deploymentOverrides,
  };
  setDeployment(deployment);

  if (deployment.admin.bootstrapAccount) {
    const bootstrap = deployment.admin.bootstrapAccount;
    if (!getStmt("getUserByNamespace").get(bootstrap.namespace)) {
      const hash = hashPassword(bootstrap.password);
      getStmt("createUser").run(
        bootstrap.namespace,
        bootstrap.displayName || "Administrator",
        hash,
        "admin",
        1,
      );
      const created = getStmt("getUserByNamespace").get(bootstrap.namespace);
      const { tosVersion, privacyVersion } = loadManifest(config.terms.dir);
      getStmt("updateUserTermsAcceptance").run(
        nowIso(),
        tosVersion,
        nowIso(),
        privacyVersion,
        created.id,
      );
    }
  }

  const app = express();
  app.use(express.raw({ type: "application/javascript", limit: "1mb" }));
  app.use(express.raw({ type: "text/markdown", limit: "1mb" }));
  app.use(express.json());

  app.use(
    "/v0/auth",
    (req, res, next) => {
      const isPublic =
        req.method === "POST" &&
        ["/signup", "/login"].some((p) => req.path === p);
      if (isPublic) return next();
      authMiddleware(req, res, next);
    },
    termsMiddleware,
    authRoutes,
  );
  app.use(
    "/v0",
    (req, res, next) => {
      const termPaths = [
        "/terms",
        "/privacy",
        "/terms/accept",
        "/admin/terms",
        "/admin/privacy",
      ];
      if (!termPaths.includes(req.path)) return next();
      if (req.method === "GET") return next();
      authMiddleware(req, res, next);
    },
    termsRoutes,
  );
  app.use("/v0/users", optionalAuthMiddleware, termsMiddleware, userRoutes);
  app.use(
    "/v0/extensions",
    optionalAuthMiddleware,
    termsMiddleware,
    extensionRoutes,
  );
  app.use("/v0/stats", statsRoutes);
  app.use("/v0/versions", authMiddleware, termsMiddleware, versionRoutes);
  app.use("/v0/webhooks", authMiddleware, termsMiddleware, webhookRoutes);
  app.use("/v0/notifications", authMiddleware, termsMiddleware, notificationRoutes);

  return {
    app,
    db,
    dataDir,
    config,
    deployment,
    cleanup() {
      db.close();
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

      if (options.body && typeof options.body === "string") {
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

      if (options.body) {
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

export { readFileSync, join };
