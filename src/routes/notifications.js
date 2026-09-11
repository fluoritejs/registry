import { Router } from "express";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import { parseCursor, encodeCursor, parseLimit } from "../pagination.js";
import { nowIso } from "../auth.js";

const router = Router();

function requireAuth(req, res, next) {
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
}

router.use(requireAuth);

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

router.get("/", (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const offset = parseCursor(req.query);
  const status = req.query.status;

  let notifications;
  if (status === "read") {
    notifications = getStmt("listNotificationsRead").all(
      req.auth.user.id,
      limit + 1,
      offset,
    );
  } else if (status === "unread") {
    notifications = getStmt("listNotificationsUnread").all(
      req.auth.user.id,
      limit + 1,
      offset,
    );
  } else {
    notifications = getStmt("listNotifications").all(
      req.auth.user.id,
      limit + 1,
      offset,
    );
  }

  const sliced = notifications.slice(0, limit);
  const nextCursor =
    notifications.length > limit ? encodeCursor(offset + limit) : null;

  if (config.notifications?.includeUnreadCountHeader !== false) {
    const unread = getStmt("countUnreadNotifications").get(
      req.auth.user.id,
    ).count;
    res.set("X-Unread-Notifications", String(unread));
  }

  res.json({ notifications: sliced.map(notificationJson), nextCursor });
});

router.delete("/", (req, res) => {
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
  getStmt("deleteReadNotifications").run(req.auth.user.id);
  res.status(204).end();
});

router.patch("/:id", (req, res) => {
  const n = getStmt("getNotification").get(Number(req.params.id));
  if (!n || n.user_id !== req.auth.user.id) {
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
  const updated = getStmt("markNotificationRead").get(nowIso(), n.id);
  res.json(notificationJson(updated));
});

router.delete("/:id", (req, res) => {
  const n = getStmt("getNotification").get(Number(req.params.id));
  if (!n || n.user_id !== req.auth.user.id) {
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
  getStmt("deleteNotification").run(n.id);
  res.status(204).end();
});

export default router;
