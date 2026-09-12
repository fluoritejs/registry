import { Router } from "express";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import {
  parseKeysetCursor,
  encodeKeysetCursor,
  parseLimit,
} from "../pagination.js";
import { nowIso } from "../auth.js";

const router = Router();

function notificationJson(n) {
  return {
    id: String(n.id),
    message: n.message,
    packageId: n.package_id || null,
    version: n.version || null,
    readAt: n.read_at || null,
    createdAt: n.created_at,
  };
}

router.get("/", async (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const after = parseKeysetCursor(req.query) ?? 2_147_483_647;
  const status = req.query.status;
  if (status !== undefined && status !== "read" && status !== "unread") {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: 'status must be "read" or "unread".',
          field: "status",
        },
      });
  }

  let notifications;
  if (status === "read") {
    notifications = await getStmt("listNotificationsRead").all(
      req.auth.user.id,
      after,
      limit + 1,
    );
  } else if (status === "unread") {
    notifications = await getStmt("listNotificationsUnread").all(
      req.auth.user.id,
      after,
      limit + 1,
    );
  } else {
    notifications = await getStmt("listNotifications").all(
      req.auth.user.id,
      after,
      limit + 1,
    );
  }

  const sliced = notifications.slice(0, limit);
  const nextCursor =
    notifications.length > limit
      ? encodeKeysetCursor(sliced[sliced.length - 1].id)
      : null;

  if (config.notifications?.includeUnreadCountHeader !== false) {
    const unread = await getStmt("countUnreadNotifications").get(
      req.auth.user.id,
    );
    res.set("X-Unread-Notifications", String(unread.count));
  }

  res.json({ notifications: sliced.map(notificationJson), nextCursor });
});

router.delete("/", async (req, res) => {
  const status = req.query.status;
  if (status !== "read") {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "status=read is required for bulk delete.",
          field: "status",
        },
      });
  }
  await getStmt("deleteReadNotifications").run(req.auth.user.id);
  res.status(204).end();
});

function notificationNotFound(res) {
  return res
    .status(404)
    .json({
      error: {
        code: "NOT_FOUND",
        message: "Notification not found.",
        field: null,
      },
    });
}

async function resolveNotification(req, res, next) {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return notificationNotFound(res);
  const n = await getStmt("getNotification").get(id);
  if (!n || n.user_id !== req.auth.user.id) return notificationNotFound(res);
  req.notification = n;
  next();
}

router.patch("/:id", resolveNotification, async (req, res) => {
  const updated = await getStmt("markNotificationRead").get(
    nowIso(),
    req.notification.id,
  );
  if (!updated) return notificationNotFound(res);
  res.json(notificationJson(updated));
});

router.delete("/:id", resolveNotification, async (req, res) => {
  await getStmt("deleteNotification").run(req.notification.id);
  res.status(204).end();
});

export default router;
