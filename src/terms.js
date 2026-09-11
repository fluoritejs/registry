import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import yaml from "js-yaml";
import { getConfig } from "./config.js";

function manifestPath(termsDir) {
  return join(termsDir, "manifest.yaml");
}

export function contentPath(termsDir, name, version) {
  return version
    ? join(termsDir, `${name}.${version}.md`)
    : join(termsDir, `${name}.md`);
}

const manifestCache = new Map();
const publishChains = new Map();

export function loadManifest(termsDir) {
  const path = manifestPath(termsDir);
  let mtime;
  try {
    if (existsSync(path)) mtime = statSync(path).mtimeMs;
  } catch (err) {
    if (getConfig()?.terms?.enforce === true) throw err;
    mtime = undefined;
  }
  const cached = manifestCache.get(path);
  if (cached && cached.mtime === mtime) {
    return { ...cached.manifest };
  }
  let manifest;
  if (mtime === undefined) {
    manifest = { tosVersion: "", privacyVersion: "" };
  } else {
    try {
      const raw = yaml.load(readFileSync(path, "utf8")) || {};
      manifest = {
        tosVersion: String(raw.tosVersion || ""),
        privacyVersion: String(raw.privacyVersion || ""),
      };
    } catch (err) {
      if (err?.code === "ENOENT") {
        manifest = { tosVersion: "", privacyVersion: "" };
      } else if (getConfig()?.terms?.enforce === true) {
        throw err;
      } else {
        manifest = { tosVersion: "", privacyVersion: "" };
      }
    }
  }
  manifestCache.set(path, { mtime, manifest });
  return { ...manifest };
}

export function saveManifest(termsDir, manifest) {
  mkdirSync(termsDir, { recursive: true });
  const text = yaml.dump(manifest);
  writeFileSync(manifestPath(termsDir), text, "utf8");
}

export function readContent(termsDir, name, version) {
  const path = contentPath(termsDir, name, version);
  if (existsSync(path)) return readFileSync(path, "utf8");
  if (version) {
    const legacy = contentPath(termsDir, name);
    if (existsSync(legacy)) return readFileSync(legacy, "utf8");
  }
  return null;
}

export function writeContent(termsDir, name, content) {
  mkdirSync(termsDir, { recursive: true });
  writeFileSync(contentPath(termsDir, name), content, "utf8");
}

function assertSafeVersion(version) {
  const segments = String(version).split(/[\\/]/);
  if (
    typeof version !== "string" ||
    version.length === 0 ||
    segments.length > 1 ||
    segments.some((s) => s === "." || s === "..")
  ) {
    throw new Error(`Invalid version: ${version}`);
  }
}

export class TermsVersionConflictError extends Error {
  constructor(label, version) {
    super(
      `Version ${version} is already published for ${label} with different content; publish a new version instead.`,
    );
    this.name = "TermsVersionConflictError";
  }
}

function runPublishPair(termsDir, name, content, label, version) {
  assertSafeVersion(version);
  mkdirSync(termsDir, { recursive: true });
  const contentFile = contentPath(termsDir, name, version);
  const manifestFile = manifestPath(termsDir);
  const manifest = loadManifest(termsDir);
  if (manifest[label] === version) {
    const existing = readContent(termsDir, name, version);
    if (existing !== content) {
      throw new TermsVersionConflictError(label, version);
    }
  }
  manifest[label] = version;
  const cookie = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const contentTmp = `${contentFile}.${cookie}.tmp`;
  const manifestTmp = `${manifestFile}.${cookie}.tmp`;
  try {
    writeFileSync(contentTmp, content, "utf8");
    writeFileSync(manifestTmp, yaml.dump(manifest), "utf8");
    renameSync(contentTmp, contentFile);
    renameSync(manifestTmp, manifestFile);
    manifestCache.delete(manifestFile);
  } catch (err) {
    try {
      if (existsSync(contentTmp)) unlinkSync(contentTmp);
    } catch {
      /* ignore */
    }
    try {
      if (existsSync(manifestTmp)) unlinkSync(manifestTmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function publishPair(termsDir, name, content, label, version) {
  const key = resolve(termsDir);
  const prev = publishChains.get(key) ?? Promise.resolve();
  const next = prev.then(() =>
    runPublishPair(termsDir, name, content, label, version),
  );
  publishChains.set(
    key,
    next.catch(() => {}),
  );
  return next;
}
