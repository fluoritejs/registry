import crypto from "node:crypto";
import { getStmt } from "./db.js";
import { log } from "./logger.js";
import { getConfig } from "./config.js";

export function signPayload(body, secret) {
  const secretBuf = Buffer.from(secret, "hex");
  const sig = crypto.createHmac("sha256", secretBuf).update(body).digest("hex");
  return `sha256=${sig}`;
}

export function fireWebhooks(event, payload) {
  const cfg = getConfig().webhooks;
  if (!cfg) return;

  const webhooks = getStmt("listEnabledWebhooksForEvent").all(`%${event}%`);
  if (!webhooks.length) return;

  const body = JSON.stringify({
    event,
    extension: payload.extension,
    version: payload.version,
    timestamp: new Date().toISOString(),
  });

  for (const wh of webhooks) {
    const events = JSON.parse(wh.events);
    if (!events.includes(event)) continue;

    deliverWithRetry(wh, body, event, cfg);
  }
}

async function deliverWithRetry(wh, body, event, cfg) {
  const secretBuf = Buffer.from(wh.secret_hash, "hex");
  const signature = `sha256=${crypto.createHmac("sha256", secretBuf).update(body).digest("hex")}`;

  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.deliveryTimeoutMs);

      const res = await fetch(wh.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Fluorite-Signature": signature,
        },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (res.ok) {
        log.debug(`Webhook delivered to ${wh.url} (${event})`);
        return;
      }
      log.warn(
        `Webhook delivery to ${wh.url} returned ${res.status} (attempt ${attempt + 1})`,
      );
    } catch (err) {
      log.warn(
        `Webhook delivery to ${wh.url} failed: ${err.message} (attempt ${attempt + 1})`,
      );
    }

    if (attempt < cfg.maxRetries) {
      await new Promise((r) =>
        setTimeout(r, cfg.retryBackoffMs * (attempt + 1)),
      );
    }
  }

  log.error(`Webhook delivery to ${wh.url} exhausted retries`);
}
