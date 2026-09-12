import { Router } from "express";
import { getStmt, deleteUserCascade, runTransaction } from "../db.js";
import {
  hashPassword,
  verifyPassword,
  userJson,
  requireSession,
} from "../auth.js";
import { getConfig } from "../config.js";
import {
  parseKeysetCursor,
  encodeKeysetCursor,
  parseLimit,
} from "../pagination.js";
import { isSafeSegment } from "../validate.js";
import { log } from "../logger.js";

const router = Router();

const MAX_DISPLAY_NAME = 255;

function invalidDisplayName(value) {
  return typeof value !== "string" || value.length > MAX_DISPLAY_NAME;
}

router.get("/", async (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const after = parseKeysetCursor(req.query) ?? 0;
  const users = await getStmt("listUsers").all(after, limit + 1);
  const sliced = users.slice(0, limit);
  const nextCursor =
    users.length > limit
      ? encodeKeysetCursor(sliced[sliced.length - 1].id)
      : null;
  res.json({ users: sliced.map((u) => userJson(u)), nextCursor });
});

router.post("/", requireSession, async (req, res) => {
  if (req.auth.user.type !== "admin") {
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
  const { namespace, password, displayName } = req.body ?? {};
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
  const existing = await getStmt("getUserByNamespace").get(namespace);
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
  if (displayName !== undefined && invalidDisplayName(displayName)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: `displayName must be a string of at most ${MAX_DISPLAY_NAME} characters.`,
          field: "displayName",
        },
      });
  }
  const hash = await hashPassword(password);
  let result;
  try {
    result = await getStmt("createUser").get(
      namespace,
      displayName || "",
      hash,
      "normal",
      0,
    );
  } catch (err) {
    if (err?.code === "23505") {
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
    throw err;
  }
  const user = await getStmt("getUserById").get(result.id);
  log.info(`Admin created user: ${namespace}`);
  res.status(201).json(userJson(user));
});

router.get("/:namespace", async (req, res) => {
  const user = await getStmt("getUserByNamespace").get(req.params.namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  res.json(userJson(user));
});

router.patch("/:namespace", requireSession, async (req, res) => {
  const target = await getStmt("getUserByNamespace").get(req.params.namespace);
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

  const { displayName, password, currentPassword } = req.body ?? {};
  if (displayName !== undefined && invalidDisplayName(displayName)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: `displayName must be a string of at most ${MAX_DISPLAY_NAME} characters.`,
          field: "displayName",
        },
      });
  }

  if (
    password !== undefined &&
    isOwner &&
    (typeof currentPassword !== "string" ||
      !verifyPassword(currentPassword, target.password_hash))
  ) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "currentPassword must match the account's current password.",
          field: "currentPassword",
        },
      });
  }

  let updatedUser = target;
  let passwordHash;

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
    passwordHash = await hashPassword(password);
  }

  if (password !== undefined || displayName !== undefined) {
    await runTransaction(async () => {
      if (password !== undefined) {
        await getStmt("updateUserPassword").run(passwordHash, target.namespace);
        await getStmt("deleteAllAuthTokens").run(target.id);
        await getStmt("deleteAllAutomationTokens").run(target.id);
      }
      if (displayName !== undefined) {
        await getStmt("updateUserDisplayName").run(
          displayName,
          target.namespace,
        );
      }
    });
    if (password !== undefined) {
      log.info(
        `Password changed for ${target.namespace} — all sessions and tokens revoked`,
      );
    }
    updatedUser = await getStmt("getUserByNamespace").get(target.namespace);
  }

  res.json(userJson(updatedUser));
});

router.delete("/:namespace", requireSession, async (req, res) => {
  const target = await getStmt("getUserByNamespace").get(req.params.namespace);
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
  try {
    const result = await deleteUserCascade(target.id);
    if (result.missing) {
      return res
        .status(404)
        .json({
          error: { code: "NOT_FOUND", message: "User not found.", field: null },
        });
    }
    if (result.pending) {
      log.warn(
        `Account data deletion pending for ${target.namespace}: blobs left for retry`,
      );
      return res
        .status(202)
        .json({
          pending: true,
          message:
            "Some blobs could not be removed; deletions remain pending for retry.",
        });
    }
  } catch (err) {
    if (err.code === "LAST_ADMIN") {
      return res
        .status(409)
        .json({
          error: {
            code: "LAST_ADMIN",
            message: "Cannot delete the only remaining admin.",
            field: null,
          },
        });
    }
    log.error(
      `Failed to delete account data for ${target.namespace}: ${err.message}`,
    );
    return res
      .status(500)
      .json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to delete account data.",
          field: null,
        },
      });
  }
  log.info(`User deleted: ${target.namespace}`);
  res.status(204).end();
});

router.patch("/:namespace/role", requireSession, async (req, res) => {
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
  const target = await getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const { type } = req.body ?? {};
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
  if (type === "normal" && target.type === "admin") {
    let updated = null;
    let demoteBlocked = false;
    await runTransaction(async () => {
      const { count } = await getStmt("countAdminsForUpdate").get();
      if (count <= 1) {
        demoteBlocked = true;
        return;
      }
      updated = await getStmt("updateUserRole").get(type, target.namespace);
    });
    if (demoteBlocked) {
      return res
        .status(409)
        .json({
          error: {
            code: "LAST_ADMIN",
            message: "Cannot demote the only remaining admin.",
            field: null,
          },
        });
    }
    if (!updated) {
      return res
        .status(404)
        .json({
          error: { code: "NOT_FOUND", message: "User not found.", field: null },
        });
    }
    return res.json(userJson(updated));
  }
  const updated = await getStmt("updateUserRole").get(type, target.namespace);
  if (!updated) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  res.json(userJson(updated));
});

router.patch("/:namespace/trust", requireSession, async (req, res) => {
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
  const target = await getStmt("getUserByNamespace").get(req.params.namespace);
  if (!target) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  const { trusted } = req.body ?? {};
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
  const updated = await getStmt("updateUserTrust").get(
    trusted ? 1 : 0,
    target.namespace,
  );
  if (!updated) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }
  res.json(userJson(updated));
});

export default router;
