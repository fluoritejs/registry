import { Router } from "express";
import { adminMiddleware } from "../auth.js";
import { getStmt } from "../db.js";
import { getConfig } from "../config.js";
import {
  parseKeysetCursor,
  encodeKeysetCursor,
  parseLimit,
} from "../pagination.js";
import { versionJson } from "../version-json.js";

const router = Router();

router.get("/", adminMiddleware, async (req, res) => {
  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const after = parseKeysetCursor(req.query) ?? 2_147_483_647;
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

  const versions = await getStmt("listVersionsWorklist").all(
    status,
    after,
    limit + 1,
  );
  const sliced = versions.slice(0, limit);
  const nextCursor =
    versions.length > limit
      ? encodeKeysetCursor(sliced[sliced.length - 1].id)
      : null;

  res.json({
    versions: sliced.map((v) => versionJson(v, { includeNamespace: true })),
    nextCursor,
  });
});

export default router;
