import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

function manifestPath(termsDir) {
  return join(termsDir, "manifest.yaml");
}

export function contentPath(termsDir, name) {
  return join(termsDir, `${name}.md`);
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

export function readContent(termsDir, name) {
  const path = contentPath(termsDir, name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function writeContent(termsDir, name, content) {
  mkdirSync(termsDir, { recursive: true });
  writeFileSync(contentPath(termsDir, name), content, "utf8");
}