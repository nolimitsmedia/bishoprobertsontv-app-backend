// server-api/routes/public.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// const { fixVideoUrls, fixPlaylistUrls } = require("../utils/transform");
const { fixVideoUrls, fixPlaylistUrls } = require("../services/fixUrls");

/* =======================================================
   PUBLIC CATEGORIES
   GET /api/public/categories
========================================================== */
router.get("/categories", async (req, res) => {
  try {
    const { search } = req.query;
    const params = [];

    let where = `
      WHERE v.is_published = TRUE
        AND v.visibility IN ('public','unlisted')
        AND v.category_id IS NOT NULL
    `;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND c.name ILIKE $${params.length}`;
    }

    const sql = `
      SELECT DISTINCT c.id, c.name, c.thumbnail_url
      FROM categories c
      JOIN videos v ON v.category_id = c.id
      ${where}
      ORDER BY c.name ASC
    `;

    const r = await db.query(sql, params);

    // Auto-fix category thumbnail URLs
    const items = r.rows.map((c) => ({
      ...c,
      thumbnail_url: fixVideoUrls(req, { thumbnail_url: c.thumbnail_url })
        .thumbnail_url,
    }));

    res.json({ items });
  } catch (e) {
    console.error("[GET /api/public/categories] error:", e);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

/* =======================================================
   PUBLIC VIDEOS
   GET /api/public/videos
========================================================== */
router.get("/videos", async (req, res) => {
  try {
    const { search, limit = 100, only_free } = req.query;

    const params = [];
    let where = `
      WHERE v.is_published = TRUE
        AND v.visibility IN ('public','unlisted')
        AND v.category_id IS NOT NULL
    `;

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

    const items = r.rows.map((v) => fixVideoUrls(req, v));

    res.json({ items });
  } catch (e) {
    console.error("[GET /api/public/videos] error:", e);
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

/* =======================================================
   PUBLIC PLAYLISTS (legacy)
   GET /api/public/playlists
========================================================== */
router.get("/playlists", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 24, 200));
    const search = String(req.query.search || "").trim();
    const nonempty = req.query.nonempty === "0" ? false : true;

    const params = [];
    let idx = 1;

    // Match your rules in playlists.js
    const PUBLIC_VIDEO_WHERE = `
      v.is_published = TRUE
      AND COALESCE(v.visibility, 'public') <> 'unlisted'
    `;

    let where = `WHERE p.visibility = 'public'`;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (p.title ILIKE $${idx} OR p.description ILIKE $${idx})`;
      idx++;
    }

    params.push(limit);

    const sql = `
      SELECT
        p.id,
        p.title,
        COALESCE(p.slug, LOWER(REPLACE(p.title, ' ', '-'))) AS slug,
        p.description,
        p.thumbnail_url,
        p.visibility,
        p.featured_category_id,
        cat.name AS featured_category_name,
        cat.slug AS featured_category_slug,
        p.created_at,
        COUNT(v.id)::int AS video_count,
        COUNT(v.id)::int AS item_count,
        COALESCE(SUM(v.duration_seconds),0)::int AS duration_total
      FROM playlists p
      LEFT JOIN categories cat ON cat.id = p.featured_category_id
      LEFT JOIN playlist_videos pv ON pv.playlist_id = p.id
      LEFT JOIN videos v
        ON v.id = pv.video_id
       AND ${PUBLIC_VIDEO_WHERE}
      ${where}
      GROUP BY p.id, cat.name, cat.slug
      ${nonempty ? "HAVING COUNT(v.id) > 0" : ""}
      ORDER BY p.created_at DESC
      LIMIT $${idx}
    `;

    const r = await db.query(sql, params);

    // Keep URL fixing behavior consistent
    const items = (r.rows || []).map((p) => fixPlaylistUrls(req, p));

    res.json({ items });
  } catch (e) {
    console.error("[GET /public/playlists] error", e);
    res.status(500).json({ message: "Failed to load playlists" });
  }
});

module.exports = router;
