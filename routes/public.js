// server-api/routes/public.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/**
 * PUBLIC CATEGORIES
 * Returns categories that actually have at least one PUBLISHED video.
 * Optional search across category name.
 *
 * GET /api/public/categories?search=
 */
router.get("/categories", async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];

    let where = `WHERE v.is_published = TRUE
                   AND v.visibility IN ('public','unlisted')
                   AND v.category_id IS NOT NULL`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND c.name ILIKE $${params.length}`;
    }

    const sql = `
      SELECT DISTINCT c.id, c.name
      FROM categories c
      JOIN videos v ON v.category_id = c.id
      ${where}
      ORDER BY c.name ASC
    `;
    const r = await db.query(sql, params);
    res.json({ items: r.rows });
  } catch (e) {
    console.error("[GET /api/public/categories] error:", e);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

/**
 * PUBLIC VIDEOS
 * Returns PUBLISHED videos that have a category.
 * Query:
 *   - limit (default 100)
 *   - search (title/description)
 *   - only_free=1 (is_premium = false)
 *
 * GET /api/public/videos?limit=1000&search=grace&only_free=1
 */
router.get("/videos", async (req, res) => {
  try {
    const { search, limit = 100, only_free } = req.query;

    const params = [];
    let where = `WHERE v.is_published = TRUE
                   AND v.visibility IN ('public','unlisted')
                   AND v.category_id IS NOT NULL`;

    if (only_free === "1" || only_free === "true") {
      where += " AND v.is_premium = false";
    }

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`;
    }

    params.push(Number(limit) || 100);

    const sql = `
      SELECT
        v.*,
        c.name AS category_name
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY v.created_at DESC
      LIMIT $${params.length}
    `;

    const r = await db.query(sql, params);
    res.json({ items: r.rows });
  } catch (e) {
    console.error("[GET /api/public/videos] error:", e);
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

// LEGACY public playlists (collections). Keeping for compatibility if needed.
// Prefer the dedicated /api/playlists/public endpoints.
router.get("/playlists", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 24), 100);

    const sql = `
      SELECT c.id,
             c.title,
             c.slug,
             c.thumbnail_url,
             c.created_at,
             COUNT(cv.video_id) AS video_count,
             COALESCE(SUM(v.duration_seconds),0)::int AS duration_total
      FROM collections c
      LEFT JOIN collection_videos cv ON cv.collection_id = c.id
      LEFT JOIN videos v ON v.id = cv.video_id
      WHERE LOWER(COALESCE(c.type,'')) = 'playlist'
        AND (c.visibility IS NULL OR c.visibility = 'public')
      GROUP BY c.id
      ORDER BY c.created_at DESC
      LIMIT $1
    `;
    const r = await db.query(sql, [limit]);
    res.json({ items: r.rows });
  } catch (e) {
    console.error("[GET /public/playlists] error", e);
    res.status(500).json({ message: "Failed to load playlists" });
  }
});

module.exports = router;
