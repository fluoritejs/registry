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

export const WORKLIST_STATUSES = [
  "staging",
  "pending",
  "published",
  "rejected",
  "pending_delete",
];

const router = Router();

// Upper bound for the descending versions.id ordering: cursors are keyed on
// the int4 primary key, so the worklist starts from this sentinel when no
// cursor is supplied.
const DESC_CURSOR_SENTINEL = 2_147_483_647;

router.get("/", adminMiddleware, async (req, res) => {
  const status = req.query.status;
  if (!WORKLIST_STATUSES.includes(status)) {
    return res
      .status(400)
      .json({
        error: {
          code: "VALIDATION_ERROR",
          message:
            "status must be one of staging, pending, published, rejected, pending_delete.",
          field: "status",
        },
      });
  }

  const config = getConfig();
  const maxPageSize = config.listings.maxPageSize;
  const defaultSize = config.listings.defaultPageSize;
  const limit = parseLimit(req.query, defaultSize, maxPageSize);
  const after = parseKeysetCursor(req.query) ?? DESC_CURSOR_SENTINEL;

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
