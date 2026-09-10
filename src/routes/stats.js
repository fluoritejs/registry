import { Router } from "express";
import { getStmt } from "../db.js";

const router = Router();

router.get("/", (req, res) => {
  const stats = getStmt("stats").get();
  res.json({
    published: stats.published,
    pending: stats.pending,
    authors: stats.authors,
    totalDownloads: stats.totalDownloads,
  });
});

export default router;
