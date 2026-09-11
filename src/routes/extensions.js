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
import { getStmt, blobPath, stagingBlobPath, runTransaction } from "../db.js";
import { extractManifest } from "../manifest.js";
import {
  nowIso,
  authMiddleware,
  scopeMiddleware,
  adminMiddleware,
} from "../auth.js";
import { getConfig, getDeployment } from "../config.js";
import {
  parseKeysetCursor,
  encodeKeysetCursor,
  parseLimit,
} from "../pagination.js";
import { fireWebhooks } from "../webhooks.js";
import { versionJson } from "../version-json.js";
import { log } from "../logger.js";

const router = Router();

function highestVersion(rows) {
  const valid = (rows || []).filter((r) => semver.valid(r.version));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) =>
    semver.rcompare(a.version, b.version) <= 0 ? a : b,
  );
}

function aggregateExtensions(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.namespace}\0${row.package_id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((versions) => {
    const latest = highestVersion(versions);
    const totalDownloads = versions.reduce((s, v) => s + v.downloads, 0);
    const meta = JSON.parse(latest.meta_json || "{}");
    return {
      namespace: latest.namespace,
      id: latest.package_id,
      name: meta.name,
      description: meta.description,
      license: meta.license,
      latestVersion: latest.version,
      publishedAt: latest.published_at,
      totalDownloads,
    };
  });
}

function parseNamespace(ns) {
  return ns.startsWith("@") ? ns.slice(1) : ns;
}

function finalizeBlobDelete(v) {
  if (v.blob_path && existsSync(v.blob_path)) {
    try {
      unlinkSync(v.blob_path);
    } catch (err) {
      getStmt("markVersionDeletionPending").run(v.id);
      log.warn(
        `Failed to delete blob ${v.blob_path}: ${err.message} (left pending for retry)`,
      );
      return false;
    }
  }
  getStmt("deleteVersion").run(v.id);
  return true;
}

router.get("/", (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const after = parseKeysetCursor(req.query) ?? Number.MAX_SAFE_INTEGER;
  const q = req.query.q;

  const identities = q
    ? getStmt("searchExtensionIdentities").all(q, q, q, q, after, limit + 1)
    : getStmt("listExtensionIdentities").all(after, limit + 1);

  const hasMore = identities.length > limit;
  const page = hasMore ? identities.slice(0, limit) : identities;

  const allRows = [];
  for (const { namespace, package_id } of page) {
    const rows = getStmt("listVersionsByExtension").all(namespace, package_id);
    allRows.push(...rows);
  }

  const extensions = aggregateExtensions(allRows);
  const nextCursor = hasMore
    ? encodeKeysetCursor(page[page.length - 1].sort_key)
    : null;

  res.json({ extensions, nextCursor });
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
  if (
    statusFilter !== undefined &&
    statusFilter !== "all" &&
    statusFilter !== "published"
  ) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: 'status must be "published" or "all".',
          field: "status",
        },
      });
  }
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

  if (!versions.length) {
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

router.delete(
  "/:namespace/:id",
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
    let pending = false;
    for (const v of versions) {
      if (!finalizeBlobDelete(v)) pending = true;
    }
    if (pending) {
      log.warn(`Extension delete left pending blobs: ${namespace}/${id}`);
      return res
        .status(202)
        .json({
          pending: true,
          message:
            "One or more blobs could not be removed; the delete remains pending for retry.",
        });
    }
    getStmt("deleteVersionsByOwnerAndPackage").run(user.id, id);
    log.info(`Extension deleted: ${namespace}/${id}`);
    res.status(204).end();
  },
);

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

    const publishedVersions = getStmt("highestPublishedVersion").all(
      user.id,
      id,
    );
    const published = highestVersion(publishedVersions);
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

    const stagingPath = stagingBlobPath(
      dataDir,
      namespace,
      id,
      manifest.version,
      crypto.randomUUID().replace(/-/g, "").slice(0, 16),
    );
    const finalPath = blobPath(dataDir, namespace, id, manifest.version);

    const trusted =
      !!user.trusted || !getConfig().publishing.firstPublishRequiresReview;
    const status = trusted ? "published" : "pending";
    const publishedAt = trusted ? nowIso() : null;

    let versionId;
    let blobOwned = false;
    try {
      runTransaction(() => {
        getStmt("createVersion").run(
          user.id,
          id,
          manifest.version,
          "staging",
          JSON.stringify(manifest),
          finalPath,
          nowIso(),
          null,
        );
        versionId = getStmt("getVersionByOwnerPackageVersion").get(
          user.id,
          id,
          manifest.version,
        ).id;
      });

      writeFileSync(stagingPath, source, "utf8");
      renameSync(stagingPath, finalPath);
      blobOwned = true;

      runTransaction(() => {
        getStmt("finalizeVersion").run(
          status,
          publishedAt,
          finalPath,
          versionId,
        );
      });
      blobOwned = false;
    } catch (err) {
      if (blobOwned) {
        try {
          if (existsSync(finalPath)) unlinkSync(finalPath);
        } catch {
          /* ignore */
        }
      }
      try {
        if (existsSync(stagingPath)) unlinkSync(stagingPath);
      } catch {
        /* ignore */
      }
      if (versionId !== undefined) {
        try {
          getStmt("deleteVersion").run(versionId);
        } catch {
          /* ignore */
        }
      }
      log.error(`Publish failed: ${err.message}`);
      return res
        .status(500)
        .json({
          error: {
            code: "INTERNAL_ERROR",
            message: "Failed to publish version.",
            field: null,
          },
        });
    }

    const version = getStmt("getVersion").get(namespace, id, manifest.version);

    try {
      const event = trusted ? "version.published" : "version.pending";
      fireWebhooks(event, {
        extension: { namespace, id },
        version: { version: manifest.version, status },
      });

      log.info(
        `Version published: ${namespace}/${id}@${manifest.version} (status=${status})`,
      );
    } catch (err) {
      log.error(
        `Post-publish workflow failed for ${namespace}/${id}@${manifest.version}: ${err.message}`,
      );
    }

    res.status(201).json(versionJson(version));
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
    const candidates = getStmt("resolveLatestVersion").all(namespace, id);
    v = highestVersion(candidates);
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

  const isOwner = req.auth && req.auth.user.id === user.id;
  const isAdmin = req.auth && req.auth.user.type === "admin";
  if (!isOwner && !isAdmin && v.status !== "published") {
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
    const { status: newStatus, reason } = req.body ?? {};

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

    const message =
      newStatus === "approved"
        ? `Your version ${version} of ${id} has been approved.`
        : `Your version ${version} of ${id} has been rejected.${reason ? ` Reason: ${reason}` : ""}`;

    runTransaction(() => {
      getStmt("updateVersionStatus").run(dbStatus, publishedAt, v.id);

      if (newStatus === "approved") {
        const owner = getStmt("getUserById").get(v.owner_id);
        if (owner && !owner.trusted) {
          getStmt("updateUserTrust").run(1, namespace);
          log.info(`User ${namespace} is now trusted (first approval)`);
        }
      }

      getStmt("createNotification").run(
        v.owner_id,
        message,
        id,
        version,
        null,
        nowIso(),
      );
    });

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

router.delete(
  "/:namespace/:id/versions/:version",
  authMiddleware,
  scopeMiddleware("publish"),
  (req, res) => {
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

    if (!finalizeBlobDelete(v)) {
      log.warn(
        `Version delete left blob pending: ${namespace}/${id}@${version}`,
      );
      return res
        .status(202)
        .json({
          pending: true,
          message:
            "Blob could not be removed; deletion remains pending for retry.",
        });
    }
    log.info(`Version deleted: ${namespace}/${id}@${version}`);
    res.status(204).end();
  },
);

router.patch(
  "/:namespace/:id/versions/:version/yank",
  authMiddleware,
  scopeMiddleware("publish"),
  (req, res) => {
    const namespace = parseNamespace(req.params.namespace);
    const { id, version } = req.params;
    const { yanked, reason } = req.body ?? {};

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
  },
);

export default router;
