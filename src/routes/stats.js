import { Router } from "express";
import { getStmt } from "../db.js";

const router = Router();

router.get("/", async (req, res) => {
  const stats = await getStmt("stats").get();
  res.set("Cache-Control", "public, max-age=60");
  res.json({
    published: stats.published,
    pending: stats.pending,
    authors: stats.authors,
    totalDownloads: stats.totalDownloads,
  });
});

export default router;
