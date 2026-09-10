import { Router } from "express";
import { existsSync, unlinkSync } from "node:fs";
import { getStmt, deleteUserCascade } from "../db.js";
import { hashPassword, userJson } from "../auth.js";
import { getConfig } from "../config.js";
import { parseCursor, encodeCursor, parseLimit } from "../pagination.js";
import { isSafeSegment } from "../validate.js";
import { log } from "../logger.js";

const router = Router();

router.get("/", (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const offset = parseCursor(req.query);
  const users = getStmt("listUsers").all(limit + 1, offset);
  const sliced = users.slice(0, limit);
  const nextCursor =
    users.length > limit ? encodeCursor(offset + limit) : null;
  res.json({ users: sliced.map((u) => userJson(u)), nextCursor });
});

router.post("/", (req, res) => {
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
  const { namespace, password, displayName } = req.body;
  if (
    !namespace ||
    typeof namespace !== "string" ||
    typeof password !== "string" ||
    password.length < 8
  ) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "namespace is required and password must be a string of at least 8 characters.",
          field: null,
        },
      });
  }
  const config = getConfig();
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
  const hash = hashPassword(password);
  const result = getStmt("createUser").get(
    namespace,
    displayName || "",
    hash,
    "normal",
    0,
  );
  const user = getStmt("getUserById").get(result.id);
  log.info(`Admin created user: ${namespace}`);
  res.status(201).json(userJson(user));
});

router.get("/:namespace", (req, res) => {
  const user = getStmt("getUserByNamespace").get(req.params.namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  res.json(userJson(user));
});

router.patch("/:namespace", (req, res) => {
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
  const target = getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const isOwner = req.auth.user.id === target.id;
  const isAdmin = req.auth.user.type === "admin";
  if (!isOwner && !isAdmin) {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Can only update your own profile.",
          field: null,
        },
      });
  }

  const { displayName, password } = req.body;
  let updatedUser = target;

  if (password !== undefined) {
    if (typeof password !== "string" || password.length < 8) {
      return res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Password must be a string of at least 8 characters.",
            field: "password",
          },
        });
    }
    const hash = hashPassword(password);
    getStmt("updateUserPassword").run(hash, target.namespace);
    getStmt("deleteAllAuthTokens").run(target.id);
    getStmt("deleteAllAutomationTokens").run(target.id);
    log.info(
      `Password changed for ${target.namespace} — all sessions and tokens revoked`,
    );
    updatedUser = getStmt("getUserByNamespace").get(target.namespace);
  }

  if (displayName !== undefined) {
    getStmt("updateUserDisplayName").run(displayName, target.namespace);
    updatedUser = getStmt("getUserByNamespace").get(target.namespace);
  }

  res.json(userJson(updatedUser));
});

router.delete("/:namespace", (req, res) => {
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
  const target = getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const isOwner = req.auth.user.id === target.id;
  const isAdmin = req.auth.user.type === "admin";
  if (!isOwner && !isAdmin) {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Can only delete your own account.",
          field: null,
        },
      });
  }
  const versions = getStmt("listVersionsByUser").all(target.id);
  for (const v of versions) {
    try {
      if (v.blob_path && existsSync(v.blob_path)) unlinkSync(v.blob_path);
    } catch (err) {
      log.warn(`Failed to delete blob ${v.blob_path}: ${err.message}`);
    }
  }
  getStmt("deleteAllAuthTokens").run(target.id);
  getStmt("deleteAllAutomationTokens").run(target.id);
  deleteUserCascade(target.id);
  log.info(`User deleted: ${target.namespace}`);
  res.status(204).end();
});

router.patch("/:namespace/role", (req, res) => {
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
  const target = getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const { type } = req.body;
  if (!type || !["admin", "normal"].includes(type)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: 'type must be "admin" or "normal".',
          field: "type",
        },
      });
  }
  const updated = getStmt("updateUserRole").get(type, target.namespace);
  res.json(userJson(updated));
});

router.patch("/:namespace/trust", (req, res) => {
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
  const target = getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const { trusted } = req.body;
  if (typeof trusted !== "boolean") {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "trusted must be a boolean.",
          field: "trusted",
        },
      });
  }
  const updated = getStmt("updateUserTrust").get(
    trusted ? 1 : 0,
    target.namespace,
  );
  res.json(userJson(updated));
});

export default router;
