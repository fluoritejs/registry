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
import { getStmt } from "./db.js";
import { isSafeSegment } from "./validate.js";

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
  let stat;
  try {
    if (existsSync(path)) stat = statSync(path);
  } catch (err) {
    if (getConfig()?.terms?.enforce === true) throw err;
    stat = undefined;
  }
  const cached = manifestCache.get(path);
  if (cached && cached.mtime === stat?.mtimeMs && cached.size === stat?.size) {
    return { ...cached.manifest };
  }
  let manifest;
  if (stat === undefined) {
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
  manifestCache.set(path, { mtime: stat?.mtimeMs, size: stat?.size, manifest });
  return { ...manifest };
}

export function saveManifest(termsDir, manifest) {
  mkdirSync(termsDir, { recursive: true });
  const path = manifestPath(termsDir);
  const cookie = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const tmp = `${path}.${cookie}.tmp`;
  try {
    writeFileSync(tmp, yaml.dump(manifest), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
  manifestCache.delete(path);
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
  if (!isSafeSegment(version)) {
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

async function runPublishPair(termsDir, name, content, label, version) {
  await getStmt("lockTermsDir").run(`terms-${resolve(termsDir)}`);
  try {
    return runPublishPairSync(termsDir, name, content, label, version);
  } finally {
    await getStmt("unlockTermsDir").run(`terms-${resolve(termsDir)}`);
  }
}

function runPublishPairSync(termsDir, name, content, label, version) {
  assertSafeVersion(version);
  mkdirSync(termsDir, { recursive: true });
  const contentFile = contentPath(termsDir, name, version);
  const manifestFile = manifestPath(termsDir);
  const manifest = loadManifest(termsDir);
  if (manifest[label] === version) {
    const existing = existsSync(contentFile)
      ? readFileSync(contentFile, "utf8")
      : null;
    if (existing !== null && existing !== content) {
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
