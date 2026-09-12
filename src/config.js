import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { log } from "./logger.js";

const DEPLOYMENT_DEFAULTS = {
  server: {
    port: 3000,
    publicBaseUrl: "http://localhost:3000",
    requireHttps: false,
  },
  storage: { dataDir: "./data" },
  database: {
    host: "localhost",
    port: 5432,
    database: "fluorite",
    user: "fluorite",
    password: "",
  },
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
    maxResponseBodySize: 1048576,
    encryptionKey: "",
  },
  server: { shutdownTimeoutMs: 5000, shutdownTimeoutMaxMs: 9000 },
  terms: { dir: "./terms", enforce: false },
  logging: { level: "info" },
};

function deepMerge(base, overrides, path = "") {
  const result = structuredClone(base);
  for (const key of Object.keys(overrides)) {
    if (key === "__proto__" || key === "constructor") continue;
    const childPath = path ? `${path}.${key}` : key;
    const overrideIsNull = overrides[key] === null;
    const baseIsMapping =
      typeof base[key] === "object" &&
      base[key] !== null &&
      !Array.isArray(base[key]);
    if (overrideIsNull && baseIsMapping) {
      throw new Error(
        `Configuration error: ${childPath} must be an object, not null.`,
      );
    }
    if (
      overrides[key] !== null &&
      typeof overrides[key] === "object" &&
      !Array.isArray(overrides[key]) &&
      baseIsMapping
    ) {
      result[key] = deepMerge(base[key], overrides[key], childPath);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

function parseDuration(s) {
  let ms;
  if (typeof s === "number") {
    ms = s;
  } else {
    const match = String(s).match(/^(\d+)(s|m|h|d)$/);
    if (!match) throw new Error(`Invalid duration: ${s}`);
    const n = parseInt(match[1], 10);
    switch (match[2]) {
      case "s":
        ms = n * 1000;
        break;
      case "m":
        ms = n * 60_000;
        break;
      case "h":
        ms = n * 3_600_000;
        break;
      case "d":
        ms = n * 86_400_000;
        break;
    }
  }
  // Reject non-positive durations and any duration that would land outside the
  // ECMA-262 Date range (matches expiryDate() bounds).
  if (
    !Number.isFinite(ms) ||
    ms <= 0 ||
    Date.now() + ms > 8_640_000_000_000_000
  ) {
    throw new Error(`Invalid duration: ${s}`);
  }
  return ms;
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

function resolveBootstrapPassword(account) {
  let password = account.password;
  if (account.passwordFromEnv !== undefined) {
    if (
      typeof account.passwordFromEnv !== "string" ||
      !account.passwordFromEnv
    ) {
      throw new Error(
        "deployment.yaml: admin.bootstrapAccount.passwordFromEnv must name an environment variable.",
      );
    }
    const envValue = process.env[account.passwordFromEnv];
    if (!envValue) {
      throw new Error(
        `deployment.yaml: admin.bootstrapAccount.passwordFromEnv refers to ${account.passwordFromEnv}, which is not set.`,
      );
    }
    password = envValue;
  }
  if (account.passwordFile !== undefined) {
    if (typeof account.passwordFile !== "string" || !account.passwordFile) {
      throw new Error(
        "deployment.yaml: admin.bootstrapAccount.passwordFile must be a file path.",
      );
    }
    try {
      password = readFileSync(account.passwordFile, "utf8").replace(
        /\r?\n$/,
        "",
      );
    } catch (err) {
      throw new Error(
        `deployment.yaml: could not read admin.bootstrapAccount.passwordFile ${account.passwordFile}: ${err.message}`,
        { cause: err },
      );
    }
  }
  return password;
}

function validateBootstrapPassword(password) {
  if (password === "change-me-immediately" || password === "REPLACE_ME") {
    throw new Error(
      "deployment.yaml: admin.bootstrapAccount password is still a placeholder. " +
        "Generate an operator password and set it via passwordFromEnv or passwordFile.",
    );
  }
  if (typeof password !== "string" || password.length < 8) {
    throw new Error(
      "deployment.yaml: admin.bootstrapAccount password must be at least 8 characters.",
    );
  }
}

export function loadDeployment(overrides = {}) {
  const raw = deepMerge(
    DEPLOYMENT_DEFAULTS,
    deepMerge(loadYaml(resolve("deployment.yaml")), overrides),
  );
  validateDeployment(raw);
  if (!raw.database?.connectionString && process.env.FLUORITE_DATABASE_URL) {
    raw.database.connectionString = process.env.FLUORITE_DATABASE_URL;
  }
  if (raw.admin.bootstrapAccount) {
    raw.admin.bootstrapAccount.password = resolveBootstrapPassword(
      raw.admin.bootstrapAccount,
    );
    validateBootstrapPassword(raw.admin.bootstrapAccount.password);
  }
  raw.storage.dataDir = resolve(raw.storage.dataDir);
  return raw;
}

function validateEncryptionKey(cfg) {
  const key = cfg.webhooks?.encryptionKey;
  if (key === undefined || key === "") return;
  if (typeof key !== "string" || !/^[0-9a-f]{64}$/i.test(key)) {
    throw new Error(
      "config.yaml: webhooks.encryptionKey must be a 64-character hex string " +
        "(32 random bytes) for AES-256-GCM. Generate one with: openssl rand -hex 32",
    );
  }
}

export function loadConfig(overrides = {}) {
  const raw = deepMerge(
    CONFIG_DEFAULTS,
    deepMerge(loadYaml(resolve("config.yaml")), overrides),
  );
  raw.auth.tokenTtlMs = parseDuration(raw.auth.tokenTtl);
  validateEncryptionKey(raw);
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
  if (currentConfig) {
    const activeKey = currentConfig.webhooks?.encryptionKey;
    const freshKey = fresh.webhooks?.encryptionKey;
    if (freshKey !== activeKey) {
      log.warn(
        "SIGHUP reload: webhooks.encryptionKey changed in config; ignoring to preserve active key until decrypt-and-re-encrypt rotation is implemented.",
      );
      fresh.webhooks.encryptionKey = activeKey;
    }
  }
  currentConfig = fresh;
  return fresh;
}

export { parseDuration, deepMerge, CONFIG_DEFAULTS, DEPLOYMENT_DEFAULTS };
