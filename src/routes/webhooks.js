import { Router } from "express";
import crypto from "node:crypto";
import { getStmt } from "../db.js";
import { nowIso } from "../auth.js";
import {
  isSafeWebhookUrl,
  encryptSecret,
  getEncryptionKey,
} from "../webhooks.js";
import { log } from "../logger.js";

const router = Router();

const WEBHOOK_EVENTS = [
  "version.published",
  "version.pending",
  "version.approved",
  "version.rejected",
  "version.yanked",
];

function validateEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return "events must be a non-empty array.";
  }
  const invalid = events.filter((e) => !WEBHOOK_EVENTS.includes(e));
  if (invalid.length > 0) {
    return `Invalid events: ${invalid.join(", ")}`;
  }
  return null;
}

function webhookJson(wh) {
  return {
    id: wh.id,
    url: wh.url,
    events: JSON.parse(wh.events),
    enabled: !!wh.enabled,
    createdAt: wh.created_at,
  };
}

router.get("/", (req, res) => {
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
  const webhooks = getStmt("listWebhooks").all();
  res.json(webhooks.map(webhookJson));
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
  const { url, events } = req.body;
  if (typeof url !== "string" || url.length === 0) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "url and events are required.",
          field: null,
        },
      });
  }
  const eventsError = validateEvents(events);
  if (eventsError) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: eventsError,
          field: "events",
        },
      });
  }
  if (!isSafeWebhookUrl(url)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid webhook URL.",
          field: "url",
        },
      });
  }
  if (!getEncryptionKey()) {
    return res
      .status(500)
      .json({
        error: {
          code: "WEBHOOK_ENCRYPTION_REQUIRED",
          message:
            "webhooks.encryptionKey is not configured. Generate one with `openssl rand -hex 32` and add it to config.yaml before creating webhooks.",
          field: null,
        },
      });
  }

  const secret = crypto.randomBytes(32).toString("hex");

  const id = crypto.randomUUID();
  const encryptedSecret = encryptSecret(secret);

  getStmt("createWebhook").run(
    id,
    url,
    JSON.stringify(events),
    encryptedSecret,
    1,
    nowIso(),
  );

  log.info(`Webhook created: ${id} -> ${url}`);

  res
    .status(201)
    .json({ id, url, events, enabled: true, createdAt: nowIso(), secret });
});

router.patch("/:id", (req, res) => {
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
  const existing = getStmt("getWebhook").get(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Webhook not found.",
          field: null,
        },
      });
  }

  const { url, events, enabled } = req.body;
  if (url !== undefined) {
    if (typeof url !== "string" || !isSafeWebhookUrl(url)) {
      return res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid webhook URL.",
            field: "url",
          },
        });
    }
  }
  if (events !== undefined) {
    const eventsError = validateEvents(events);
    if (eventsError) {
      return res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: eventsError,
            field: "events",
          },
        });
    }
  }
  const newUrl = url ?? existing.url;
  const newEvents = events ? JSON.stringify(events) : existing.events;
  const newEnabled =
    enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;

  getStmt("updateWebhook").run(newUrl, newEvents, newEnabled, req.params.id);

  const updated = getStmt("getWebhook").get(req.params.id);
  res.json(webhookJson(updated));
});

router.delete("/:id", (req, res) => {
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
  const existing = getStmt("getWebhook").get(req.params.id);
  if (!existing) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Webhook not found.",
          field: null,
        },
      });
  }
  getStmt("deleteWebhook").run(req.params.id);
  res.status(204).end();
});

export default router;
