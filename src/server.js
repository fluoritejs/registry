import { createServer } from "node:http";
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
import { hashPassword, nowIso } from "./auth.js";
import { loadManifest } from "./terms.js";
import { createApp } from "./app.js";
import { join } from "node:path";

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
    const created = getStmt("getUserByNamespace").get(
      deployment.admin.bootstrapAccount.namespace,
    );
    const { tosVersion, privacyVersion } = loadManifest(config.terms.dir);
    getStmt("updateUserTermsAcceptance").run(
      nowIso(),
      tosVersion,
      nowIso(),
      privacyVersion,
      created.id,
    );
    log.info(
      `Bootstrap admin account created: ${deployment.admin.bootstrapAccount.namespace}`,
    );
  }
}

const app = createApp();

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

server.listen(PORT, () => {
  log.info(`Fluorite Registry listening on port ${PORT}`);
});

export { app, server, db };
