import { Router } from "express";
import crypto from "node:crypto";
import { getStmt } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  generateToken,
  hashToken,
  nowIso,
  expiryDate,
  successResponse,
  rateLimitMiddleware,
  requireSession,
  userJson,
} from "../auth.js";
import { getConfig, getDeployment } from "../config.js";
import { isSafeSegment } from "../validate.js";
import { log } from "../logger.js";

const router = Router();

const sessionAuth = [
  (req, res, next) => {
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
    next();
  },
  requireSession,
];

router.get("/me", sessionAuth, (req, res) => {
  res.json(userJson(req.auth.user));
});

router.post("/signup", rateLimitMiddleware("signup"), (req, res) => {
  const { namespace, password, displayName } = req.body;
  const config = getConfig();

  if (!namespace || !password) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "namespace and password are required.",
          field: null,
        },
      });
  }
  if (password.length < 8) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Password must be at least 8 characters.",
          field: "password",
        },
      });
  }

  if (!isSafeSegment(namespace)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid namespace format.",
          field: "namespace",
        },
      });
  }

  const nsRe = new RegExp(config.publishing.namespacePattern);
  if (!nsRe.test(namespace)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid namespace format.",
          field: "namespace",
        },
      });
  }

  const existing = getStmt("getUserByNamespace").get(namespace);
  if (existing) {
    return res
      .status(409)
      .json({
        error: {
          code: "NAMESPACE_TAKEN",
          message: "This namespace is already taken.",
          field: "namespace",
        },
      });
  }

  const userCount = getStmt("countUsers").get().count;
  let type = "normal";
  let trusted = 0;
  if (getDeployment().admin.firstUserBecomesAdmin && userCount === 0) {
    type = "admin";
    trusted = 1;
  }

  const hash = hashPassword(password);
  const user = getStmt("createUser").get(
    namespace,
    displayName || "",
    hash,
    type,
    trusted,
  );

  const token = generateToken();
  const tokenHash = hashToken(token);
  getStmt("createAuthToken").run(user.id, tokenHash, nowIso(), expiryDate());

  const createdUser = getStmt("getUserById").get(user.id);
  log.info(`User signed up: ${namespace} (type=${type})`);

  const response = successResponse(res, createdUser, token, config);
  res.status(201).json(response);
});

router.post("/login", rateLimitMiddleware("login"), (req, res) => {
  const { namespace, password } = req.body;

  if (!namespace || !password) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid credentials.",
          field: null,
        },
      });
  }

  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user || !user.password_hash) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid credentials.",
          field: null,
        },
      });
  }

  if (!verifyPassword(password, user.password_hash)) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid credentials.",
          field: null,
        },
      });
  }

  const token = generateToken();
  const tokenHash = hashToken(token);
  getStmt("createAuthToken").run(user.id, tokenHash, nowIso(), expiryDate());

  log.info(`User logged in: ${namespace}`);

  const config = getConfig();
  const response = successResponse(res, user, token, config);
  res.json(response);
});

router.post("/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const tokenHash = hashToken(authHeader.slice(7));
    const session = getStmt("getAuthToken").get(tokenHash);
    if (session) {
      getStmt("deleteAuthToken").run(session.id);
    }
  }
  res.status(204).end();
});

router.get("/sessions", sessionAuth, (req, res) => {
  const sessions = getStmt("listAuthTokens").all(req.auth.user.id);
  const now = new Date();
  const active = sessions
    .filter((s) => new Date(s.expires_at) > now)
    .map((s) => ({
      id: s.token_hash,
      createdAt: s.created_at,
      expiresAt: s.expires_at,
    }));
  res.json(active);
});

router.delete("/sessions", sessionAuth, (req, res) => {
  getStmt("deleteAllAuthTokens").run(req.auth.user.id);
  res.status(204).end();
});

router.delete("/sessions/:id", sessionAuth, (req, res) => {
  const sessions = getStmt("listAuthTokens").all(req.auth.user.id);
  const session = sessions.find((s) => s.token_hash === req.params.id);
  if (!session) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Session not found.",
          field: null,
        },
      });
  }
  getStmt("deleteAuthToken").run(session.id);
  res.status(204).end();
});

router.get("/tokens", sessionAuth, (req, res) => {
  const tokens = getStmt("listAutomationTokens").all(req.auth.user.id);
  res.json(
    tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: JSON.parse(t.scopes),
      createdAt: t.created_at,
      lastUsedAt: t.last_used_at,
    })),
  );
});

router.post("/tokens", sessionAuth, (req, res) => {
  const { name, scopes } = req.body;
  if (!name || !scopes || !Array.isArray(scopes) || scopes.length === 0) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "name and scopes are required.",
          field: null,
        },
      });
  }
  const validScopes = ["publish"];
  const invalid = scopes.filter((s) => !validScopes.includes(s));
  if (invalid.length > 0) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: `Invalid scopes: ${invalid.join(", ")}`,
          field: "scopes",
        },
      });
  }

  const token = generateToken();
  const id = crypto.randomUUID();
  const tokenHash = hashToken(token);
  getStmt("createAutomationToken").run(
    id,
    req.auth.user.id,
    name,
    tokenHash,
    JSON.stringify(scopes),
    nowIso(),
  );

  log.info(`Automation token created: ${name} for ${req.auth.user.namespace}`);

  res
    .status(201)
    .json({ id, name, scopes, createdAt: nowIso(), lastUsedAt: null, token });
});

router.delete("/tokens/:id", sessionAuth, (req, res) => {
  const result = getStmt("deleteAutomationToken").run(
    req.params.id,
    req.auth.user.id,
  );
  if (result.changes === 0) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "Token not found.", field: null },
      });
  }
  res.status(204).end();
});

export default router;
