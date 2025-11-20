// server-api/routes/resources.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/**
 * GET /api/resources/by-video/:id
 * Returns resources stored in the video's metadata (metadata.resources).
 * Shape: { items: [{ title, url }] }
 *
 * This is intentionally simple and does NOT require entitlements. If you later
 * want to enforce access, you can check the video's visibility/is_premium
 * and the authenticated user here before returning resources.
 */
router.get("/by-video/:id", async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ message: "Invalid id" });
  }

  try {
    const q = await db.query(
      `SELECT id, visibility, is_premium, metadata
         FROM videos
        WHERE id = $1
        LIMIT 1`,
      [id]
    );

    if (q.rowCount === 0) {
      // Not found → return empty list (UI is fine with no resources)
      return res.json({ items: [] });
    }

    const row = q.rows[0] || {};
    const md = row.metadata || {};
    const items = Array.isArray(md.resources)
      ? md.resources
          .filter(Boolean)
          .map((r) => ({
            title: String(r.title || "").trim(),
            url: String(r.url || "").trim(),
          }))
          .filter((r) => r.title || r.url)
      : [];

    return res.json({ items });
  } catch (err) {
    console.error("[GET /resources/by-video] error:", err);
    return res.status(500).json({ message: "Failed to load resources" });
  }
});

module.exports = router;
