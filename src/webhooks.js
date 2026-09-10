import crypto from "node:crypto";
import net from "node:net";
import { getStmt } from "./db.js";
import { log } from "./logger.js";
import { getConfig } from "./config.js";

export function signPayload(body, secret) {
  const secretBuf = Buffer.from(secret, "hex");
  const sig = crypto.createHmac("sha256", secretBuf).update(body).digest("hex");
  return `sha256=${sig}`;
}

export function isSafeWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  if (!parsed.hostname) return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return !isRestrictedIp(host);
}

function isRestrictedIp(host) {
  if (net.isIPv4(host)) {
    const [a, b, c, d] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 198 && b === 18) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    if (h === "::" || h === "::1") return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
      return true;
    }
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  return false;
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

    deliverWithRetry(wh, body, event, cfg).catch((err) => {
      log.error(`Webhook delivery to ${wh.url} crashed: ${err.message}`);
    });
  }
}

async function deliverWithRetry(wh, body, event, cfg) {
  if (!wh.secret || !isSafeWebhookUrl(wh.url)) {
    throw new Error(`Refusing unsafe webhook delivery to ${wh.url}`);
  }
  const signature = signPayload(body, wh.secret);

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
        redirect: "manual",
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
