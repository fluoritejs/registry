import { createServer } from "node:http";
import express from "express";
import {
  loadDeployment,
  loadConfig,
  setConfig,
  setDeployment,
  reloadConfig,
} from "./config.js";
import {
  openDb,
  migrate,
  reconcileStaging,
  cleanupTempBlobs,
  prepare,
  getStmt,
} from "./db.js";
import { setLevel, log } from "./logger.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
  hashPassword,
} from "./auth.js";
import { join } from "node:path";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import extensionRoutes from "./routes/extensions.js";
import versionRoutes from "./routes/versions.js";
import webhookRoutes from "./routes/webhooks.js";
import notificationRoutes from "./routes/notifications.js";
import statsRoutes from "./routes/stats.js";

const deployment = loadDeployment();
setDeployment(deployment);
const config = loadConfig();
setConfig(config);
setLevel(config.logging.level);

const dbPath = join(deployment.storage.dataDir, "registry.sqlite");
const db = openDb(dbPath);
migrate(db);
prepare(db);

cleanupTempBlobs(deployment.storage.dataDir);
reconcileStaging(db, deployment.storage.dataDir);

if (
  !deployment.admin.firstUserBecomesAdmin &&
  deployment.admin.bootstrapAccount
) {
  const existing = getStmt("getUserByNamespace").get(
    deployment.admin.bootstrapAccount.namespace,
  );
  if (!existing) {
    const hash = hashPassword(deployment.admin.bootstrapAccount.password);
    getStmt("createUser").run(
      deployment.admin.bootstrapAccount.namespace,
      deployment.admin.bootstrapAccount.displayName || "Administrator",
      hash,
      "admin",
      1,
    );
    log.info(
      `Bootstrap admin account created: ${deployment.admin.bootstrapAccount.namespace}`,
    );
  }
}

const app = express();
app.set("trust proxy", "loopback");

app.use((req, res, next) => {
  if (deployment.server.requireHttps && !req.secure && !isLoopback(req)) {
    return res
      .status(400)
      .json({
        error: {
          code: "HTTPS_REQUIRED",
          message: "HTTPS is required for non-loopback connections.",
          field: null,
        },
      });
  }
  next();
});

app.use(express.raw({ type: "application/javascript", limit: "1mb" }));
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    log.debug(`${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Auth routes: public POST to /signup and /login, protected everything else
app.use(
  "/v0/auth",
  (req, res, next) => {
    const isPublic =
      req.method === "POST" &&
      ["/signup", "/login"].some((p) => req.path === p);
    if (isPublic) return next();
    authMiddleware(req, res, next);
  },
  authRoutes,
);

// Public routes
app.use("/v0/users", optionalAuthMiddleware, userRoutes);
app.use("/v0/extensions", optionalAuthMiddleware, extensionRoutes);
app.use("/v0/stats", statsRoutes);

// Authenticated routes
app.use("/v0/versions", authMiddleware, versionRoutes);
app.use("/v0/webhooks", authMiddleware, webhookRoutes);
app.use("/v0/notifications", authMiddleware, notificationRoutes);

app.use((err, req, res, _next) => {
  log.error(`Unhandled error: ${err.message}`);
  res
    .status(500)
    .json({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal error occurred.",
        field: null,
      },
    });
});

const PORT = deployment.server.port;
const server = createServer(app);

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down...");

  const timeoutMs = Math.min(
    config.server.shutdownTimeoutMs,
    config.server.shutdownTimeoutMaxMs,
  );

  const forceExit = setTimeout(() => {
    log.warn("Shutdown timed out, forcing exit");
    process.exit(1);
  }, timeoutMs);

  server.close(() => {
    clearTimeout(forceExit);
    log.info("HTTP server closed");
    db.close();
    log.info("Database closed");
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("SIGHUP", () => {
  log.info("Received SIGHUP, reloading config.yaml...");
  const fresh = reloadConfig();
  setLevel(fresh.logging.level);
  log.info("Config reloaded");
});

function isLoopback(req) {
  const ip = req.socket.remoteAddress;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

server.listen(PORT, () => {
  log.info(`Fluorite Registry listening on port ${PORT}`);
});

export { app, server, db };
