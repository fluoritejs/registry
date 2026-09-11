import { Router } from "express";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import { parseCursor, encodeCursor, parseLimit } from "../pagination.js";
import { versionJson } from "../version-json.js";

const router = Router();

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

  res.json({
    versions: sliced.map((v) => versionJson(v, { includeNamespace: true })),
    nextCursor,
  });
});

export default router;
