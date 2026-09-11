import { createServer } from "node:http";
import {
  loadDeployment,
  loadConfig,
  setConfig,
  setDeployment,
  reloadConfig,
  getConfig,
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

const deployment = loadDeployment();
setDeployment(deployment);
const config = loadConfig();
setConfig(config);
setLevel(config.logging.level);

const db = openDb(deployment.database);
prepare(db);

let app;

async function main() {
  await migrate(db);
  log.info("Database schema up to date");

  cleanupTempBlobs(deployment.storage.dataDir);
  await reconcileStaging(db, deployment.storage.dataDir);

  if (
    !deployment.admin.firstUserBecomesAdmin &&
    deployment.admin.bootstrapAccount
  ) {
    const existing = await getStmt("getUserByNamespace").get(
      deployment.admin.bootstrapAccount.namespace,
    );
    if (!existing) {
      const hash = await hashPassword(
        deployment.admin.bootstrapAccount.password,
      );
      await getStmt("createUser").run(
        deployment.admin.bootstrapAccount.namespace,
        deployment.admin.bootstrapAccount.displayName || "Administrator",
        hash,
        "admin",
        1,
      );
      const created = await getStmt("getUserByNamespace").get(
        deployment.admin.bootstrapAccount.namespace,
      );
      const { tosVersion, privacyVersion } = loadManifest(config.terms.dir);
      await getStmt("updateUserTermsAcceptance").run(
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
}

app = createApp();

const PORT = deployment.server.port;
const server = createServer(app);

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("Shutting down...");

  const active = getConfig();
  const timeoutMs = Math.min(
    active.server.shutdownTimeoutMs,
    active.server.shutdownTimeoutMaxMs,
  );

  const forceExit = setTimeout(() => {
    log.warn("Shutdown timed out, forcing exit");
    process.exit(1);
  }, timeoutMs);

  server.close(async () => {
    log.info("HTTP server closed");
    try {
      await db.end();
      log.info("Database connections closed");
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

process.on("SIGHUP", () => {
  log.info("Received SIGHUP, reloading config.yaml...");
  try {
    const fresh = reloadConfig();
    setLevel(fresh.logging.level);
    log.info("Config reloaded");
  } catch (err) {
    log.error(
      `Config reload failed, keeping the active config: ${err.message}`,
    );
  }
});

main()
  .then(() => {
    server.listen(PORT, () => {
      log.info(`Fluorite Registry listening on port ${PORT}`);
    });
  })
  .catch((err) => {
    log.error(`Startup failed: ${err.message}`);
    process.exit(1);
  });

export { app, server, db };
