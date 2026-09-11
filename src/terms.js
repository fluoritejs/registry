import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function manifestPath(termsDir) {
  return join(termsDir, "manifest.yaml");
}

export function contentPath(termsDir, name, version) {
  return version
    ? join(termsDir, `${name}.${version}.md`)
    : join(termsDir, `${name}.md`);
}

export function loadManifest(termsDir) {
  const path = manifestPath(termsDir);
  if (!existsSync(path)) return { tosVersion: "", privacyVersion: "" };
  try {
    const raw = yaml.load(readFileSync(path, "utf8")) || {};
    return {
      tosVersion: String(raw.tosVersion || ""),
      privacyVersion: String(raw.privacyVersion || ""),
    };
  } catch {
    return { tosVersion: "", privacyVersion: "" };
  }
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

export function publishPair(termsDir, name, content, label, version) {
  mkdirSync(termsDir, { recursive: true });
  const contentFile = contentPath(termsDir, name, version);
  const manifestFile = manifestPath(termsDir);
  const manifest = loadManifest(termsDir);
  manifest[label] = version;
  const cookie = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const contentTmp = `${contentFile}.${cookie}.tmp`;
  const manifestTmp = `${manifestFile}.${cookie}.tmp`;
  try {
    writeFileSync(contentTmp, content, "utf8");
    writeFileSync(manifestTmp, yaml.dump(manifest), "utf8");
    renameSync(contentTmp, contentFile);
    renameSync(manifestTmp, manifestFile);
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
