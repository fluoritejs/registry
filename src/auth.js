import crypto from "node:crypto";
import { getConfig } from "./config.js";
import { getStmt } from "./db.js";
import { loadManifest } from "./terms.js";

export function hashPassword(password) {
  const cfg = getConfig().auth.passwordHashing;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64, {
    N: cfg.N,
    r: cfg.r,
    p: cfg.p,
  });
  return `${salt}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(":");
  const cfg = getConfig().auth.passwordHashing;
  const hash = crypto.scryptSync(password, salt, 64, {
    N: cfg.N,
    r: cfg.r,
    p: cfg.p,
  });
  return crypto.timingSafeEqual(Buffer.from(hex, "hex"), hash);
}

export function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function expiryDate() {
  const ttlMs = getConfig().auth.tokenTtlMs;
  return new Date(Date.now() + ttlMs).toISOString();
}

async function successResponse(res, user, token, config) {
  if (config.notifications?.includeUnreadCountHeader !== false) {
    const unread = await getStmt("countUnreadNotifications").get(user.id);
    res.set("X-Unread-Notifications", String(unread.count));
  }
  return {
    user: {
      namespace: user.namespace,
      displayName: user.display_name,
      type: user.type,
      trusted: !!user.trusted,
      tosAcceptedAt: user.tos_accepted_at || "",
      tosVersion: user.tos_version || "",
      privacyAcceptedAt: user.privacy_accepted_at || "",
      privacyVersion: user.privacy_version || "",
    },
    token,
  };
}

function userJson(user) {
  return {
    namespace: user.namespace,
    displayName: user.display_name,
    type: user.type,
    trusted: !!user.trusted,
    tosAcceptedAt: user.tos_accepted_at || "",
    tosVersion: user.tos_version || "",
    privacyAcceptedAt: user.privacy_accepted_at || "",
    privacyVersion: user.privacy_version || "",
  };
}

const rateLimitStore = new Map();

export function clearRateLimits() {
  rateLimitStore.clear();
}

function getOrCreateEntry(key, windowMs) {
  const now = Date.now();
  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.start > entry.windowMs) {
    entry = { start: now, count: 0, windowMs };
    rateLimitStore.set(key, entry);
  }
  if (rateLimitStore.size % 100 === 0) {
    for (const [k, e] of rateLimitStore) {
      if (now - e.start > e.windowMs) rateLimitStore.delete(k);
    }
  }
  return entry;
}

function checkRateLimit(key, maxAttempts, windowMinutes) {
  const windowMs = windowMinutes * 60_000;
  const entry = getOrCreateEntry(key, windowMs);
  return entry.count < maxAttempts;
}

function recordRateLimit(key, windowMinutes) {
  const windowMs = windowMinutes * 60_000;
  const entry = getOrCreateEntry(key, windowMs);
  entry.count++;
}

export function recordSignupSuccess(req) {
  const cfg = getConfig().auth.rateLimit.signup;
  const key = `signup:${req.ip}`;
  recordRateLimit(key, cfg.windowMinutes);
}

export function rateLimitMiddleware(type) {
  return (req, res, next) => {
    const cfg = getConfig().auth.rateLimit[type];
    let key;
    if (type === "login") {
      const ns = req.body?.namespace || "unknown";
      key = `${type}:${ns}:${req.ip}`;
    } else {
      key = `${type}:${req.ip}`;
    }
    if (!checkRateLimit(key, cfg.maxAttempts, cfg.windowMinutes)) {
      return res
        .status(429)
        .json({
          error: {
            code: "RATE_LIMITED",
            message: `Too many ${type} attempts. Try again later.`,
            field: null,
          },
        });
    }
    if (type === "login") {
      recordRateLimit(key, cfg.windowMinutes);
    }
    next();
  };
}

export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or invalid authorization header.",
          field: null,
        },
      });
  }
  const token = authHeader.slice(7);
  const tokenHash = hashToken(token);

  const sessionToken = await getStmt("getAuthToken").get(tokenHash);
  if (sessionToken) {
    if (new Date(sessionToken.expires_at) < new Date()) {
      await getStmt("deleteAuthToken").run(sessionToken.id);
      return res
        .status(401)
        .json({
          error: {
            code: "TOKEN_EXPIRED",
            message: "Session token has expired.",
            field: null,
          },
        });
    }
    const user = await getStmt("getUserById").get(sessionToken.user_id);
    if (!user) {
      return res
        .status(401)
        .json({
          error: {
            code: "UNAUTHORIZED",
            message: "User not found.",
            field: null,
          },
        });
    }
    req.auth = { user, tokenKind: "session", scopes: ["publish"] };
    return next();
  }

  const autoToken = await getStmt("getAutomationToken").get(tokenHash);
  if (autoToken) {
    const user = await getStmt("getUserById").get(autoToken.user_id);
    if (!user) {
      return res
        .status(401)
        .json({
          error: {
            code: "UNAUTHORIZED",
            message: "User not found.",
            field: null,
          },
        });
    }
    const scopes = JSON.parse(autoToken.scopes);
    await getStmt("updateAutomationTokenLastUsed").run(nowIso(), autoToken.id);
    req.auth = { user, tokenKind: "automation", scopes };
    return next();
  }

  return res
    .status(401)
    .json({
      error: {
        code: "UNAUTHORIZED",
        message: "Invalid or revoked token.",
        field: null,
      },
    });
}

export function optionalAuthMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    req.auth = null;
    return next();
  }
  return authMiddleware(req, res, next);
}

export function adminMiddleware(req, res, next) {
  if (!req.auth || req.auth.user.type !== "admin") {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Admin access required.",
          field: null,
        },
      });
  }
  next();
}

export function requireSession(req, res, next) {
  if (!req.auth || req.auth.tokenKind !== "session") {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Session token required.",
          field: null,
        },
      });
  }
  next();
}

export function scopeMiddleware(scope) {
  return (req, res, next) => {
    if (!req.auth) {
      return res
        .status(401)
        .json({
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required.",
            field: null,
          },
        });
    }
    if (req.auth.tokenKind === "session") return next();
    if (!req.auth.scopes.includes(scope)) {
      return res
        .status(403)
        .json({
          error: {
            code: "INSUFFICIENT_SCOPE",
            message: `Token does not have the required scope: ${scope}.`,
            field: null,
          },
        });
    }
    next();
  };
}

export function termsMiddleware(req, res, next) {
  if (!req.auth) return next();
  if (req.auth.tokenKind === "automation") return next();
  const config = getConfig();
  if (config.terms?.enforce !== true) return next();
  const { tosVersion, privacyVersion } = loadManifest(config.terms.dir);
  if (!tosVersion && !privacyVersion) return next();
  if (
    req.auth.user.tos_version === tosVersion &&
    req.auth.user.privacy_version === privacyVersion
  ) {
    return next();
  }
  return res
    .status(403)
    .json({
      error: {
        code: "TERMS_ACCEPTANCE_REQUIRED",
        message:
          "You must accept the current terms of service and privacy policy.",
        field: null,
      },
    });
}

export { successResponse, userJson, rateLimitStore };
