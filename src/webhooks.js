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
  if (!/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(
      "webhooks.encryptionKey must be a 64-character hex string (openssl rand -hex 32).",
    );
  }
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
  let key;
  if (overrideKey) {
    if (!/^[0-9a-f]{64}$/i.test(overrideKey)) {
      throw new Error(
        "webhooks.encryptionKey must be a 64-character hex string (openssl rand -hex 32).",
      );
    }
    key = Buffer.from(overrideKey, "hex");
  } else {
    key = requireEncryptionKey();
  }
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

function ipv6ToBytes(host) {
  const h = host.toLowerCase();
  const parts = h.split("::");
  if (parts.length > 2) return null;
  const headGroups = parts[0] ? parts[0].split(":") : [];
  const tailGroups = parts.length === 2 && parts[1] ? parts[1].split(":") : [];

  const absorbDottedTail = (groups) => {
    if (!groups.length) return groups;
    const lastIndex = groups.length - 1;
    if (!groups[lastIndex].includes(".")) return groups;
    const octets = groups[lastIndex].split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
      return null;
    }
    groups[lastIndex] = ((octets[0] << 8) | octets[1]).toString(16);
    groups.push(((octets[2] << 8) | octets[3]).toString(16));
    return groups;
  };

  const head = absorbDottedTail(headGroups);
  const tail = absorbDottedTail(tailGroups);
  if (head === null || tail === null) return null;
  const hextets = head.map((g) =>
    /^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : null,
  );
  if (hextets.some((v) => v === null)) return null;
  if (parts.length === 2) {
    const pad = 8 - head.length - tail.length;
    if (pad < 0) return null;
    for (let i = 0; i < pad; i++) hextets.push(0);
    for (const g of tail) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      hextets.push(parseInt(g, 16));
    }
  } else if (head.length !== 8) {
    return null;
  }
  if (hextets.length !== 8) return null;
  const bytes = [];
  for (const value of hextets) bytes.push((value >> 8) & 0xff, value & 0xff);
  return bytes;
}

function ipv4MappedToIpv4(bytes) {
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
}

export function isRestrictedIp(host) {
  if (net.isIPv4(host)) {
    const [a, b, c] = host.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (net.isIPv6(host)) {
    const bytes = ipv6ToBytes(host);
    if (!bytes) return false;
    const mapped = ipv4MappedToIpv4(bytes);
    if (mapped) return isRestrictedIp(mapped);
    if (bytes.slice(0, 12).every((b) => b === 0)) {
      return isRestrictedIp(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    if (
      bytes[0] === 0x00 &&
      bytes[1] === 0x64 &&
      bytes[2] === 0xff &&
      bytes[3] === 0x9b
    ) {
      return isRestrictedIp(
        `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      );
    }
    if (bytes[0] === 0x20 && bytes[1] === 0x02) {
      return isRestrictedIp(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
    }
    if (
      bytes[0] === 0x20 &&
      bytes[1] === 0x01 &&
      bytes[2] === 0x00 &&
      bytes[3] === 0x00
    ) {
      return isRestrictedIp(
        `${bytes[12] ^ 0xff}.${bytes[13] ^ 0xff}.${bytes[14] ^ 0xff}.${bytes[15] ^ 0xff}`,
      );
    }
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
    if ((bytes[0] & 0xfe) === 0xfc) return true;
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
  return safe.map((candidate) => ({
    address: candidate.address,
    family: candidate.family,
  }));
}

function attemptSend(url, body, headers, pinned, deadline) {
  return new Promise((resolve, reject) => {
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) {
      reject(new Error("Webhook delivery timed out"));
      return;
    }
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
    req.setTimeout(timeLeft, () => {
      req.destroy(new Error("Webhook delivery timed out"));
    });
    const hardDeadline = setTimeout(() => {
      req.destroy(new Error("Webhook delivery timed out"));
    }, timeLeft);
    req.on("response", () => clearTimeout(hardDeadline));
    req.on("close", () => clearTimeout(hardDeadline));
    req.on("error", reject);
    req.end(body);
  });
}

async function sendHttps(url, body, headers, pinned, deadline) {
  let lastErr;
  for (const candidate of pinned) {
    if (deadline - Date.now() <= 0) {
      throw new Error("Webhook delivery timed out");
    }
    try {
      return await attemptSend(url, body, headers, candidate, deadline);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function drainResponse(res, deadline, maxResponseBodySize) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const timer = setTimeout(
      () => {
        res.destroy();
        reject(new Error("Webhook delivery timed out"));
      },
      Math.max(1, deadline - Date.now()),
    );

    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxResponseBodySize) {
        res.destroy();
        clearTimeout(timer);
        reject(new Error("Webhook response exceeded the maximum body size"));
      }
    });
    res.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    res.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function isRedirect(statusCode) {
  return statusCode >= 300 && statusCode < 400;
}

async function deliverOnce(
  urlString,
  body,
  headers,
  cfg,
  redirectCount,
  deadline,
  origin,
) {
  if (redirectCount > MAX_REDIRECTS) {
    throw permanentError("Webhook redirect limit exceeded.");
  }
  if (deadline <= Date.now()) {
    throw new Error("Webhook delivery timed out");
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
  const res = await sendHttps(url, body, headers, pinned, deadline);
  await drainResponse(res, deadline, cfg.maxResponseBodySize);
  if (isRedirect(res.statusCode)) {
    if (res.headers.location) {
      const next = new URL(res.headers.location, url).toString();
      if (new URL(next).origin !== origin) {
        throw permanentError(
          `Refusing cross-origin webhook redirect to ${next}.`,
        );
      }
      return deliverOnce(
        next,
        body,
        headers,
        cfg,
        redirectCount + 1,
        deadline,
        origin,
      );
    }
    throw permanentError(
      `Webhook destination returned ${res.statusCode} without a Location header.`,
    );
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
    "X-Fluorite-Delivery-Id": crypto.randomUUID(),
  };
  const deliveryCfg = {
    maxRetries: cfg.maxRetries ?? 0,
    deliveryTimeoutMs: cfg.deliveryTimeoutMs ?? 5000,
    retryBackoffMs: cfg.retryBackoffMs ?? 0,
    maxResponseBodySize: cfg.maxResponseBodySize ?? 1048576,
  };

  for (let attempt = 0; attempt <= deliveryCfg.maxRetries; attempt++) {
    const deadline = Date.now() + deliveryCfg.deliveryTimeoutMs;
    try {
      const status = await deliverOnce(
        wh.url,
        body,
        headers,
        deliveryCfg,
        0,
        deadline,
        new URL(wh.url).origin,
      );
      if (status >= 200 && status < 300) {
        log.debug(`Webhook delivered to ${wh.id} (${event})`);
        return;
      }
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw Object.assign(
          new Error(`Webhook destination returned ${status}`),
          { permanent: true },
        );
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
      const base = deliveryCfg.retryBackoffMs * 2 ** attempt;
      const jitter = Math.random() * deliveryCfg.retryBackoffMs;
      await new Promise((r) => setTimeout(r, base + jitter));
    }
  }

  log.error(`Webhook delivery to ${wh.url} exhausted retries`);
}

export function dispatchWebhooks(event, payload) {
  fireWebhooks(event, payload).catch((err) => {
    log.error(`Webhook dispatch for ${event} failed: ${err.message}`);
  });
}

const MAX_CONCURRENT_DELIVERIES = 8;

export async function fireWebhooks(event, payload) {
  const cfg = getConfig().webhooks;
  if (!cfg) return;

  const webhooks = await getStmt("listEnabledWebhooksForEvent").all(event);
  if (!webhooks.length) return;

  const body = JSON.stringify({
    event,
    extension: payload.extension,
    version: payload.version,
    timestamp: new Date().toISOString(),
  });

  const jobs = [];
  for (const wh of webhooks) {
    const events = JSON.parse(wh.events);
    if (!events.includes(event)) continue;
    if (!wh.secret || !isSafeWebhookUrl(wh.url)) {
      log.warn(`Refusing unsafe webhook delivery to ${wh.url}`);
      continue;
    }
    jobs.push(() =>
      deliverWithRetry(wh, body, event, cfg).catch((err) => {
        log.error(`Webhook delivery to ${wh.url} crashed: ${err.message}`);
      }),
    );
  }

  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_DELIVERIES, jobs.length) },
      async () => {
        while (jobs.length) await jobs.shift()();
      },
    ),
  );
}
