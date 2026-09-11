import { Router } from "express";
import { nowIso, requireSession, adminMiddleware } from "../auth.js";
import { getConfig } from "../config.js";
import { getStmt } from "../db.js";
import { log } from "../logger.js";
import {
  loadManifest,
  readContent,
  writeContent,
  saveManifest,
  contentPath,
} from "../terms.js";

const router = Router();

function termsDir() {
  return getConfig().terms.dir;
}

function notFound(res, name) {
  return res
    .status(404)
    .json({
      error: {
        code: "TERMS_NOT_FOUND",
        message: `The ${name} has not been published yet.`,
        field: null,
      },
    });
}

function sendDocument(res, name, label) {
  const { [label]: version } = loadManifest(termsDir());
  if (!version) return notFound(res, name);
  const content = readContent(termsDir(), name);
  if (content === null) return notFound(res, name);
  res.set("Content-Type", "text/markdown; charset=utf-8");
  res.set("X-Terms-Version", version);
  res.send(content);
}

router.get("/terms", (req, res) => sendDocument(res, "tos", "tosVersion"));

router.get("/privacy", (req, res) =>
  sendDocument(res, "privacy", "privacyVersion"),
);

router.post("/terms/accept", requireSession, (req, res) => {
  const user = req.auth.user;
  const { tosVersion, privacyVersion } = req.body || {};
  const current = loadManifest(termsDir());
  if (
    tosVersion !== current.tosVersion ||
    privacyVersion !== current.privacyVersion
  ) {
    return res
      .status(400)
      .json({
        error: {
          code: "INVALID_TERMS_VERSION",
          message:
            "The supplied terms or privacy version does not match the current one.",
          field: null,
        },
      });
  }
  getStmt("updateUserTermsAcceptance").run(
    nowIso(),
    tosVersion,
    nowIso(),
    privacyVersion,
    user.id,
  );
  res.json({ success: true });
});

function handleAdminUpdate(res, name, label, req) {
  const version = req.query.version;
  if (typeof version !== "string" || !version.trim()) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "A version query parameter is required.",
          field: "version",
        },
      });
  }
  const content =
    typeof req.body === "string" ? req.body : req.body?.toString("utf8");
  if (!content) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Markdown content is required.",
          field: null,
        },
      });
  }
  const dir = termsDir();
  writeContent(dir, name, content);
  const manifest = loadManifest(dir);
  manifest[label] = version.trim();
  saveManifest(dir, manifest);
  log.info(`Updated ${label} to version ${version.trim()}`);
  res.json({ version: version.trim(), path: contentPath(dir, name) });
}

router.patch("/admin/terms", adminMiddleware, (req, res) =>
  handleAdminUpdate(res, "tos", "tosVersion", req),
);

router.patch("/admin/privacy", adminMiddleware, (req, res) =>
  handleAdminUpdate(res, "privacy", "privacyVersion", req),
);

export default router;
