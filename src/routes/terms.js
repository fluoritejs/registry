import { Router } from "express";
import { nowIso, requireSession, adminMiddleware } from "../auth.js";
import { getConfig } from "../config.js";
import { getStmt } from "../db.js";
import { log } from "../logger.js";
import {
  loadManifest,
  readContent,
  contentPath,
  publishPair,
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
  const content = readContent(termsDir(), name, version);
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
  const trimmed = typeof version === "string" ? version.trim() : "";
  if (!trimmed) {
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
  if (
    trimmed.split(/[\\/]/).length > 1 ||
    trimmed.split(/[\\/]/).some((s) => s === "." || s === "..")
  ) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid version string.",
          field: "version",
        },
      });
  }
  const body = req.body;
  let content;
  if (typeof body === "string") {
    content = body;
  } else if (Buffer.isBuffer(body)) {
    content = body.toString("utf8");
  } else {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Markdown content must be sent as text.",
          field: "content",
        },
      });
  }
  if (!content.trim()) {
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
  try {
    publishPair(dir, name, content, label, trimmed);
  } catch (err) {
    log.error(`Failed to update ${label}: ${err.message}`);
    return res
      .status(500)
      .json({
        error: {
          code: "INTERNAL_ERROR",
          message: "Failed to update document.",
          field: null,
        },
      });
  }
  log.info(`Updated ${label} to version ${trimmed}`);
  res.json({
    version: trimmed,
    path: contentPath(dir, name, trimmed),
  });
}

router.patch("/admin/terms", adminMiddleware, (req, res) =>
  handleAdminUpdate(res, "tos", "tosVersion", req),
);

router.patch("/admin/privacy", adminMiddleware, (req, res) =>
  handleAdminUpdate(res, "privacy", "privacyVersion", req),
);

export default router;
