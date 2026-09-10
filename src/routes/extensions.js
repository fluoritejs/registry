import { Router } from "express";
import crypto from "node:crypto";
import * as semver from "semver";
import {
  writeFileSync,
  renameSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";
import { getStmt, blobPath } from "../db.js";
import { extractManifest } from "../manifest.js";
import {
  nowIso,
  authMiddleware,
  scopeMiddleware,
  adminMiddleware,
} from "../auth.js";
import { getConfig, getDeployment } from "../config.js";
import { parseCursor, encodeCursor, parseLimit } from "../pagination.js";
import { fireWebhooks } from "../webhooks.js";
import { log } from "../logger.js";

const router = Router();

function versionJson(v) {
  const meta = JSON.parse(v.meta_json || "{}");
  return {
    version: v.version,
    status: v.status,
    createdAt: v.created_at,
    publishedAt: v.published_at,
    yanked: !!v.yanked,
    yankReason: v.yank_reason || null,
    downloads: v.downloads,
    ...(meta.id
      ? {
          id: meta.id,
          name: meta.name,
          license: meta.license,
          description: meta.description,
        }
      : {}),
  };
}

function parseNamespace(ns) {
  return ns.startsWith("@") ? ns.slice(1) : ns;
}

router.get("/", (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const offset = parseCursor(req.query);
  const q = req.query.q;

  let extensions;
  if (q) {
    extensions = getStmt("searchExtensions").all(q, q, q, q, limit + 1, offset);
  } else {
    extensions = getStmt("listExtensions").all(limit + 1, offset);
  }

  const sliced = extensions.slice(0, limit);
  const nextCursor =
    extensions.length > limit ? encodeCursor(offset + limit) : null;

  res.json({
    extensions: sliced.map((e) => ({
      namespace: e.namespace,
      id: e.id,
      name: e.name,
      description: e.description,
      license: e.license,
      latestVersion: e.latestVersion,
      publishedAt: e.publishedAt,
      totalDownloads: e.totalDownloads,
    })),
    nextCursor,
  });
});

router.get("/:namespace/:id", (req, res) => {
  const namespace = parseNamespace(req.params.namespace);
  const id = req.params.id;
  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "User not found.", field: null },
      });
  }

  const statusFilter = req.query.status;
  let versions;
  if (statusFilter === "all") {
    if (
      !req.auth ||
      (req.auth.user.id !== user.id && req.auth.user.type !== "admin")
    ) {
      return res
        .status(403)
        .json({
          error: {
            code: "FORBIDDEN",
            message: 'Admin or owner access required for "all" filter.',
            field: null,
          },
        });
    }
    versions = getStmt("listVersionsByOwner").all(namespace, id);
  } else {
    versions = getStmt("listVersionsByExtension").all(namespace, id);
  }

  if (!versions.length && !statusFilter) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Extension not found.",
          field: null,
        },
      });
  }

  res.json({ namespace, id, versions: versions.map((v) => versionJson(v)) });
});

router.delete("/:namespace/:id", (req, res) => {
  if (!req.auth) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
          field: null,
        },
      });
  }
  const namespace = parseNamespace(req.params.namespace);
  const id = req.params.id;
  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Extension not found.",
          field: null,
        },
      });
  }
  const isOwner = req.auth.user.id === user.id;
  const isAdmin = req.auth.user.type === "admin";
  if (!isOwner && !isAdmin) {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Admin or owner access required.",
          field: null,
        },
      });
  }

  const versions = getStmt("listVersionsByOwner").all(namespace, id);
  for (const v of versions) {
    try {
      if (existsSync(v.blob_path)) unlinkSync(v.blob_path);
    } catch (err) {
      log.warn(`Failed to delete blob ${v.blob_path}: ${err.message}`);
    }
  }
  getStmt("deleteVersionsByOwnerAndPackage").run(user.id, id);
  log.info(`Extension deleted: ${namespace}/${id}`);
  res.status(204).end();
});

router.post(
  "/:namespace/:id/versions",
  authMiddleware,
  scopeMiddleware("publish"),
  (req, res) => {
    const namespace = parseNamespace(req.params.namespace);
    const id = req.params.id;
    const user = getStmt("getUserByNamespace").get(namespace);
    if (!user) {
      return res
        .status(404)
        .json({
          error: {
            code: "NOT_FOUND",
            message: "Namespace not found.",
            field: null,
          },
        });
    }
    if (req.auth.user.id !== user.id && req.auth.user.type !== "admin") {
      return res
        .status(403)
        .json({
          error: {
            code: "FORBIDDEN",
            message: "Can only publish to your own namespace.",
            field: null,
          },
        });
    }

    const source =
      typeof req.body === "string" ? req.body : req.body?.toString("utf8");
    if (!source) {
      return res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: "Extension source is required.",
            field: null,
          },
        });
    }

    let manifest;
    try {
      const config = getConfig();
      manifest = extractManifest(source, config.publishing.packageIdPattern);
    } catch (err) {
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_MANIFEST",
            message: err.message,
            field: null,
          },
        });
    }

    if (manifest.id !== id) {
      return res
        .status(400)
        .json({
          error: {
            code: "MANIFEST_MISMATCH",
            message: `Manifest id "${manifest.id}" does not match URL id "${id}".`,
            field: "id",
          },
        });
    }

    if (getStmt("versionExists").get(user.id, id, manifest.version)) {
      return res
        .status(409)
        .json({
          error: {
            code: "VERSION_EXISTS",
            message: `Version ${manifest.version} already exists.`,
            field: "version",
          },
        });
    }

    const published = getStmt("highestPublishedVersion").get(user.id, id);
    if (published && !semver.gt(manifest.version, published.version)) {
      return res
        .status(400)
        .json({
          error: {
            code: "VERSION_TOO_LOW",
            message: `Cannot publish version ${manifest.version}; a higher version (${published.version}) is already published.`,
            field: "version",
          },
        });
    }

    if (
      getConfig().publishing.onePendingPerOwner &&
      getStmt("hasPendingVersion").get(user.id)
    ) {
      return res
        .status(403)
        .json({
          error: {
            code: "VERSION_PENDING_REVIEW",
            message:
              "You have another version pending review. It needs to be approved or rejected before you can publish again.",
            field: null,
          },
        });
    }

    const dataDir = getDeployment().storage.dataDir;
    const dir = dirname(blobPath(dataDir, namespace, id, manifest.version));
    mkdirSync(dir, { recursive: true });

    const finalPath = blobPath(dataDir, namespace, id, manifest.version);
    const tmpPath = finalPath.replace(
      /\.js$/,
      `.tmp-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    );

    const trusted =
      !!user.trusted || !getConfig().publishing.firstPublishRequiresReview;
    const status = trusted ? "published" : "pending";
    const publishedAt = trusted ? nowIso() : null;

    try {
      writeFileSync(tmpPath, source, "utf8");
      renameSync(tmpPath, finalPath);

      getStmt("createVersion").run(
        user.id,
        id,
        manifest.version,
        status,
        JSON.stringify(manifest),
        finalPath,
        nowIso(),
        publishedAt,
      );

      const version = getStmt("getVersion").get(
        namespace,
        id,
        manifest.version,
      );

      const event = trusted ? "version.published" : "version.pending";
      fireWebhooks(event, {
        extension: { namespace, id },
        version: { version: manifest.version, status },
      });

      log.info(
        `Version published: ${namespace}/${id}@${manifest.version} (status=${status})`,
      );

      res.status(201).json(versionJson(version));
    } catch (err) {
      try {
        if (existsSync(finalPath)) unlinkSync(finalPath);
      } catch {
        /* ignore */
      }
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
      log.error(`Publish failed: ${err.message}`);
      res
        .status(500)
        .json({
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to publish version.",
            field: null,
          },
        });
    }
  },
);

router.get("/:namespace/:id/versions/:version", (req, res) => {
  const namespace = parseNamespace(req.params.namespace);
  const { id, version } = req.params;
  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "Not found.", field: null },
      });
  }

  let v;
  if (version === "latest") {
    v = getStmt("resolveLatestVersion").get(namespace, id);
    if (!v) {
      return res
        .status(404)
        .json({
          error: {
            code: "NOT_FOUND",
            message: "No published version found.",
            field: null,
          },
        });
    }
  } else {
    v = getStmt("getVersion").get(namespace, id, version);
    if (!v) {
      return res
        .status(404)
        .json({
          error: {
            code: "NOT_FOUND",
            message: "Version not found.",
            field: null,
          },
        });
    }
  }

  const accept = req.headers.accept || "";
  if (accept.includes("application/javascript")) {
    if (!existsSync(v.blob_path)) {
      return res
        .status(404)
        .json({
          error: {
            code: "BLOB_MISSING",
            message: "Compiled code not available.",
            field: null,
          },
        });
    }
    getStmt("incrementDownloads").run(v.id);
    const code = readFileSync(v.blob_path, "utf8");
    res.set("Content-Type", "application/javascript");
    res.send(code);
  } else {
    res.json(versionJson(v));
  }
});

router.patch(
  "/:namespace/:id/versions/:version",
  adminMiddleware,
  (req, res) => {
    const namespace = parseNamespace(req.params.namespace);
    const { id, version } = req.params;
    const { status: newStatus, reason } = req.body;

    if (!newStatus || !["approved", "rejected"].includes(newStatus)) {
      return res
        .status(400)
        .json({
          error: {
            code: "VALIDATION_ERROR",
            message: 'status must be "approved" or "rejected".',
            field: "status",
          },
        });
    }

    const v = getStmt("getVersion").get(namespace, id, version);
    if (!v) {
      return res
        .status(404)
        .json({
          error: {
            code: "NOT_FOUND",
            message: "Version not found.",
            field: null,
          },
        });
    }
    if (v.status !== "pending") {
      return res
        .status(400)
        .json({
          error: {
            code: "INVALID_STATUS",
            message: `Cannot ${newStatus} a version with status "${v.status}".`,
            field: null,
          },
        });
    }

    const publishedAt = newStatus === "approved" ? nowIso() : null;
    const dbStatus = newStatus === "approved" ? "published" : "rejected";
    getStmt("updateVersionStatus").run(dbStatus, publishedAt, v.id);

    if (newStatus === "approved") {
      const user = getStmt("getUserById").get(v.owner_id);
      if (user && !user.trusted) {
        const hasApproved = getStmt("listVersionsByOwner")
          .all(namespace, id)
          .some((vers) => vers.status === "published" && vers.id !== v.id);
        if (!hasApproved) {
          getStmt("updateUserTrust").run(1, namespace);
          log.info(`User ${namespace} is now trusted (first approval)`);
        }
      }
    }

    const message =
      newStatus === "approved"
        ? `Your version ${version} of ${id} has been approved.`
        : `Your version ${version} of ${id} has been rejected.${reason ? ` Reason: ${reason}` : ""}`;
    getStmt("createNotification").run(
      v.owner_id,
      message,
      id,
      version,
      null,
      nowIso(),
    );

    const event =
      newStatus === "approved" ? "version.approved" : "version.rejected";
    fireWebhooks(event, {
      extension: { namespace, id },
      version: { version, status: dbStatus },
    });

    log.info(`Version ${namespace}/${id}@${version} ${newStatus}`);

    const updated = getStmt("getVersion").get(namespace, id, version);
    res.json(versionJson(updated));
  },
);

router.delete("/:namespace/:id/versions/:version", (req, res) => {
  if (!req.auth) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
          field: null,
        },
      });
  }
  const namespace = parseNamespace(req.params.namespace);
  const { id, version } = req.params;
  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "Not found.", field: null },
      });
  }
  const v = getStmt("getVersion").get(namespace, id, version);
  if (!v) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Version not found.",
          field: null,
        },
      });
  }
  const isOwner = req.auth.user.id === user.id;
  const isAdmin = req.auth.user.type === "admin";
  if (!isOwner && !isAdmin) {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Admin or owner access required.",
          field: null,
        },
      });
  }

  try {
    if (existsSync(v.blob_path)) unlinkSync(v.blob_path);
  } catch (err) {
    log.warn(`Failed to delete blob ${v.blob_path}: ${err.message}`);
  }
  getStmt("deleteVersion").run(v.id);
  log.info(`Version deleted: ${namespace}/${id}@${version}`);
  res.status(204).end();
});

router.patch("/:namespace/:id/versions/:version/yank", (req, res) => {
  if (!req.auth) {
    return res
      .status(401)
      .json({
        error: {
          code: "UNAUTHORIZED",
          message: "Authentication required.",
          field: null,
        },
      });
  }
  const namespace = parseNamespace(req.params.namespace);
  const { id, version } = req.params;
  const { yanked, reason } = req.body;

  if (typeof yanked !== "boolean") {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "yanked must be a boolean.",
          field: "yanked",
        },
      });
  }

  const user = getStmt("getUserByNamespace").get(namespace);
  if (!user) {
    return res
      .status(404)
      .json({
        error: { code: "NOT_FOUND", message: "Not found.", field: null },
      });
  }
  const v = getStmt("getVersion").get(namespace, id, version);
  if (!v) {
    return res
      .status(404)
      .json({
        error: {
          code: "NOT_FOUND",
          message: "Version not found.",
          field: null,
        },
      });
  }
  const isOwner = req.auth.user.id === user.id;
  const isAdmin = req.auth.user.type === "admin";
  if (!isOwner && !isAdmin) {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Admin or owner access required.",
          field: null,
        },
      });
  }

  const wasYanked = v.yanked;
  getStmt("updateVersionYank").run(
    yanked ? 1 : 0,
    yanked ? reason || null : null,
    v.id,
  );

  if (yanked && !wasYanked) {
    fireWebhooks("version.yanked", {
      extension: { namespace, id },
      version: { version, status: v.status },
    });
  }

  const updated = getStmt("getVersion").get(namespace, id, version);
  res.json(versionJson(updated));
});

export default router;
