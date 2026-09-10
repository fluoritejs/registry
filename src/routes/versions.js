import { Router } from "express";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import { parseCursor, encodeCursor, parseLimit } from "../pagination.js";

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
    id: meta.id,
    name: meta.name,
    license: meta.license,
    description: meta.description,
    namespace: v.namespace,
    extensionId: v.package_id,
  };
}

router.get("/", (req, res) => {
  if (!req.auth || req.auth.user.type !== "admin") {
    return res
      .status(403)
      .json({
        error: {
          code: "FORBIDDEN",
          message: "Admin access required.",
          field: null,
        },
      });
  }

  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const offset = parseCursor(req.query);
  const status = req.query.status;

  if (!status) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message: "status query parameter is required.",
          field: "status",
        },
      });
  }

  const versions = getStmt("listVersionsWorklist").all(
    status,
    limit + 1,
    offset,
  );
  const sliced = versions.slice(0, limit);
  const nextCursor =
    versions.length > limit ? encodeCursor(offset + limit) : null;

  res.json({ versions: sliced.map((v) => versionJson(v)), nextCursor });
});

export default router;
