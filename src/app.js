import express from "express";
import { getDeployment } from "./config.js";
import { log } from "./logger.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
  termsMiddleware,
} from "./auth.js";

import authRoutes from "./routes/auth.js";
import userRoutes from "./routes/users.js";
import extensionRoutes from "./routes/extensions.js";
import versionRoutes from "./routes/versions.js";
import webhookRoutes from "./routes/webhooks.js";
import notificationRoutes from "./routes/notifications.js";
import statsRoutes from "./routes/stats.js";
import termsRoutes from "./routes/terms.js";

function isLoopback(req) {
  const ip = req.ip;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function createApp() {
  const app = express();
  const deployment = getDeployment();
  app.set("trust proxy", "loopback");

  app.use((req, res, next) => {
    if (deployment.server.requireHttps && !req.secure && !isLoopback(req)) {
      return res
        .status(403)
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
  app.use(express.raw({ type: "text/markdown", limit: "1mb" }));
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
      return authMiddleware(req, res, next);
    },
    termsMiddleware,
    authRoutes,
  );

  // Terms routes: public GET /terms and /privacy, guarded per-route
  app.use("/v0", termsRoutes);

  // Public routes
  app.use("/v0/users", optionalAuthMiddleware, termsMiddleware, userRoutes);
  app.use(
    "/v0/extensions",
    optionalAuthMiddleware,
    termsMiddleware,
    extensionRoutes,
  );
  app.use("/v0/stats", statsRoutes);

  // Authenticated routes
  app.use("/v0/versions", authMiddleware, termsMiddleware, versionRoutes);
  app.use("/v0/webhooks", authMiddleware, termsMiddleware, webhookRoutes);
  app.use(
    "/v0/notifications",
    authMiddleware,
    termsMiddleware,
    notificationRoutes,
  );

  app.use((req, res) => {
    res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "Route not found.", field: null },
      });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }
    const status =
      Number.isInteger(err.status) && err.status >= 400 && err.status < 500
        ? err.status
        : 500;
    if (status === 500) {
      log.error(`Unhandled error: ${err.message}`);
    } else {
      log.debug(`Request rejected (${status}): ${err.message}`);
    }
    res
      .status(status)
      .json({
        error: {
          code: status === 500 ? "INTERNAL_ERROR" : "BAD_REQUEST",
          message: status === 500 ? "An internal error occurred." : err.message,
          field: null,
        },
      });
  });

  return app;
}
