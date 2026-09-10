import { Router } from "express";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import { nowIso } from "../auth.js";

const router = Router();

function parseCursor(query) {
  if (!query.cursor) return 0;
  try {
    return (
      JSON.parse(Buffer.from(query.cursor, "base64").toString()).offset || 0
    );
  } catch {
    return 0;
  }
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ offset })).toString("base64");
}

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

  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = Math.min(parseInt(req.query.limit) || defaultSize, maxPageSize);
  const offset = parseCursor(req.query);
  const status = req.query.status;

  let notifications;
  if (status === "read") {
    notifications = getStmt("listNotificationsByStatus").all(
      req.auth.user.id,
      "not null",
      limit + 1,
      offset,
    );
  } else if (status === "unread") {
    notifications = getStmt("listNotificationsByStatus").all(
      req.auth.user.id,
      null,
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

  const unread = getStmt("countUnreadNotifications").get(
    req.auth.user.id,
  ).count;
  res.set("X-Unread-Notifications", String(unread));

  res.json({ notifications: sliced.map(notificationJson), nextCursor });
});

router.delete("/", (req, res) => {
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
