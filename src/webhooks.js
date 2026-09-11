import crypto from "node:crypto";
import net from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { getStmt } from "./db.js";
import { log } from "./logger.js";
import { getConfig } from "./config.js";

const MAX_REDIRECTS = 5;

export function getEncryptionKey() {
  const key = getConfig().webhooks?.encryptionKey;
  if (!key) return null;
  return Buffer.from(key, "hex");
}

function requireEncryptionKey() {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error(
      "webhooks.encryptionKey is not configured; webhook secrets cannot be encrypted. Set it in config.yaml (openssl rand -hex 32).",
    );
  }
  return key;
}

export function encryptSecret(plaintext, overrideKey) {
  const key = overrideKey
    ? Buffer.from(overrideKey, "hex")
    : requireEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptSecret(stored) {
  const key = requireEncryptionKey();
  const buf = Buffer.from(stored, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(encrypted, undefined, "utf8") + decipher.final("utf8");
}

export function signatureHeader(body, plaintext) {
  return `sha256=${crypto.createHmac("sha256", plaintext).update(body).digest("hex")}`;
}

function normalizeHost(hostname) {
  return String(hostname)
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
}

export function isSafeWebhookUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (!parsed.hostname) return false;
  if (parsed.username || parsed.password) return false;
  const host = normalizeHost(parsed.hostname);
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (net.isIP(host) && isRestrictedIp(host)) return false;
  return true;
}

export function isRestrictedIp(host) {
  if (net.isIPv4(host)) {
    const [a, b, c] = host.split(".").map(Number);
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
    const v4 = h.startsWith("::ffff:") ? h.slice(7) : null;
    if (v4 && net.isIPv4(v4)) return isRestrictedIp(v4);
    if (h === "::" || h === "::1") return true;
    if (
      h.startsWith("fe8") ||
      h.startsWith("fe9") ||
      h.startsWith("fea") ||
      h.startsWith("feb")
    ) {
      return true;
    }
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    return false;
  }
  return false;
}

function permanentError(message) {
  const err = new Error(message);
  err.permanent = true;
  return err;
}

async function resolveSafeHost(hostname) {
  const host = normalizeHost(hostname);
  let candidates;
  if (net.isIP(host)) {
    candidates = [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  } else {
    try {
      candidates = await dnsLookup(host, { all: true, verbatim: true });
    } catch {
      return null;
    }
  }
  const safe = candidates.filter(
    (candidate) => !isRestrictedIp(normalizeHost(candidate.address)),
  );
  if (!safe.length) return null;
  const chosen = safe[0];
  return { address: chosen.address, family: chosen.family };
}

function sendHttps(url, body, headers, cfg, pinned) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers,
        family: pinned.family,
        lookup: (_hostname, _options, cb) =>
          cb(null, pinned.address, pinned.family),
      },
      (res) => resolve(res),
    );
    req.setTimeout(cfg.deliveryTimeoutMs, () => {
      req.destroy(new Error("Webhook delivery timed out"));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function drainResponse(res) {
  return new Promise((resolve) => {
    res.resume();
    res.on("end", resolve);
  });
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

async function deliverOnce(urlString, body, headers, cfg, redirectCount) {
  if (redirectCount > MAX_REDIRECTS) {
    throw permanentError("Webhook redirect limit exceeded.");
  }
  const url = new URL(urlString);
  if (url.protocol !== "https:") {
    throw permanentError(
      `Refusing non-HTTPS webhook destination: ${urlString}`,
    );
  }
  const pinned = await resolveSafeHost(url.hostname);
  if (!pinned) {
    throw permanentError(
      `Refusing webhook destination that resolves to a restricted address: ${urlString}`,
    );
  }
  const res = await sendHttps(url, body, headers, cfg, pinned);
  await drainResponse(res);
  if (isRedirect(res.statusCode) && res.headers.location) {
    const next = new URL(res.headers.location, url).toString();
    return deliverOnce(next, body, headers, cfg, redirectCount + 1);
  }
  return res.statusCode;
}

export async function deliverWithRetry(wh, body, event, cfg = {}) {
  if (!wh.secret) {
    throw new Error("Webhook has no secret");
  }
  const plaintext = decryptSecret(wh.secret);
  const headers = {
    "Content-Type": "application/json",
    "X-Fluorite-Signature": signatureHeader(body, plaintext),
  };
  const deliveryCfg = {
    maxRetries: cfg.maxRetries ?? 0,
    deliveryTimeoutMs: cfg.deliveryTimeoutMs ?? 5000,
    retryBackoffMs: cfg.retryBackoffMs ?? 0,
  };

  for (let attempt = 0; attempt <= deliveryCfg.maxRetries; attempt++) {
    try {
      const status = await deliverOnce(wh.url, body, headers, deliveryCfg, 0);
      if (status >= 200 && status < 300) {
        log.debug(`Webhook delivered to ${wh.url} (${event})`);
        return;
      }
      log.warn(
        `Webhook delivery to ${wh.url} returned ${status} (attempt ${attempt + 1})`,
      );
    } catch (err) {
      if (err && err.permanent) {
        log.warn(`Refusing webhook delivery to ${wh.url}: ${err.message}`);
        throw err;
      }
      log.warn(
        `Webhook delivery to ${wh.url} failed: ${err.message} (attempt ${attempt + 1})`,
      );
    }

    if (attempt < deliveryCfg.maxRetries) {
      await new Promise((r) =>
        setTimeout(r, deliveryCfg.retryBackoffMs * (attempt + 1)),
      );
    }
  }

  log.error(`Webhook delivery to ${wh.url} exhausted retries`);
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
    if (!wh.secret || !isSafeWebhookUrl(wh.url)) {
      log.warn(`Refusing unsafe webhook delivery to ${wh.url}`);
      continue;
    }

    deliverWithRetry(wh, body, event, cfg).catch((err) => {
      log.error(`Webhook delivery to ${wh.url} crashed: ${err.message}`);
    });
  }
}
