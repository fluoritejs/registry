import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

const DEPLOYMENT_DEFAULTS = {
  server: {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    requireHttps: false,
  },
  storage: { dataDir: "./data" },
  admin: { firstUserBecomesAdmin: true, bootstrapAccount: null },
};

const CONFIG_DEFAULTS = {
  auth: {
    tokenTtl: "7d",
    passwordHashing: { algorithm: "scrypt", N: 16384, r: 8, p: 1 },
    rateLimit: {
      login: { maxAttempts: 5, windowMinutes: 15 },
      signup: { maxAttempts: 5, windowMinutes: 15 },
    },
  },
  publishing: {
    firstPublishRequiresReview: true,
    onePendingPerOwner: true,
    namespacePattern: "^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$",
    packageIdPattern: "^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,63})$",
  },
  listings: { defaultPageSize: 20, maxPageSize: 50, searchPageSize: 10 },
  notifications: { enabled: true, includeUnreadCountHeader: true },
  webhooks: {
    deliveryTimeoutMs: 5000,
    maxRetries: 3,
    retryBackoffMs: 2000,
    encryptionKey: "",
  },
  server: { shutdownTimeoutMs: 5000, shutdownTimeoutMaxMs: 9000 },
  logging: { level: "info" },
};

function deepMerge(base, overrides) {
  const result = { ...base };
  for (const key of Object.keys(overrides)) {
    if (
      overrides[key] !== null &&
      typeof overrides[key] === "object" &&
      !Array.isArray(overrides[key]) &&
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key])
    ) {
      result[key] = deepMerge(base[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

function parseDuration(s) {
  if (typeof s === "number") {
    if (!Number.isFinite(s) || s <= 0) {
      throw new Error(`Invalid duration: ${s}`);
    }
    return s;
  }
  const match = String(s).match(/^(\d+)(s|m|h|d)$/);
  if (!match) throw new Error(`Invalid duration: ${s}`);
  const n = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return n * 1000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
  }
}

function loadYaml(path) {
  try {
    return yaml.load(readFileSync(path, "utf8")) || {};
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

function validateDeployment(d) {
  if (!d.admin.firstUserBecomesAdmin && !d.admin.bootstrapAccount) {
    throw new Error(
      "deployment.yaml: admin.firstUserBecomesAdmin is false but admin.bootstrapAccount is missing. " +
        "Provide a bootstrapAccount (namespace, password) or set firstUserBecomesAdmin to true.",
    );
  }
  if (d.admin.firstUserBecomesAdmin && d.admin.bootstrapAccount) {
    throw new Error(
      "deployment.yaml: admin.firstUserBecomesAdmin is true but admin.bootstrapAccount is also set. " +
        "Remove bootstrapAccount or set firstUserBecomesAdmin to false.",
    );
  }
}

export function loadDeployment(overrides = {}) {
  const raw = deepMerge(
    DEPLOYMENT_DEFAULTS,
    deepMerge(loadYaml(resolve("deployment.yaml")), overrides),
  );
  validateDeployment(raw);
  raw.storage.dataDir = resolve(raw.storage.dataDir);
  return raw;
}

export function loadConfig(overrides = {}) {
  const raw = deepMerge(
    CONFIG_DEFAULTS,
    deepMerge(loadYaml(resolve("config.yaml")), overrides),
  );
  raw.auth.tokenTtlMs = parseDuration(raw.auth.tokenTtl);
  return raw;
}

let currentConfig = null;
let currentDeployment = null;

export function getConfig() {
  return currentConfig;
}

export function setConfig(c) {
  currentConfig = c;
}

export function getDeployment() {
  return currentDeployment;
}

export function setDeployment(d) {
  currentDeployment = d;
}

export function reloadConfig() {
  const fresh = loadConfig();
  currentConfig = fresh;
  return fresh;
}

export { parseDuration, deepMerge, CONFIG_DEFAULTS, DEPLOYMENT_DEFAULTS };
