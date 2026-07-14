// server-api/routes/public.js

const express = require("express");
const router = express.Router();
const db = require("../db");

const { fixVideoUrls, fixPlaylistUrls } = require("../services/fixUrls");

/* ─── helpers ────────────────────────────────────────────── */
function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// Safe column for ORDER BY — whitelist only
const ALLOWED_SORT_COLS = new Set([
  "published_at",
  "created_at",
  "title",
  "views",
  "view_count",
  "duration_seconds",
]);

function resolveSortCol(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim();
  // Accept aliases from the frontend
  if (s === "sort_by" || s === "") return "v.published_at";
  return ALLOWED_SORT_COLS.has(s) ? `v.${s}` : "v.published_at";
}

function resolveOrder(raw) {
  return String(raw || "")
    .toLowerCase()
    .trim() === "asc"
    ? "ASC"
    : "DESC";
}

/* ═══════════════════════════════════════════════════════════
   PUBLIC CATEGORIES
   GET /api/public/categories
════════════════════════════════════════════════════════════ */
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

    // OPTIMIZATION 4: include video_count so frontend doesn't need a second query
    const sql = `
      SELECT
        c.id,
        c.name,
        c.thumbnail_url,
        COUNT(v.id)::int AS video_count
      FROM categories c
      JOIN videos v ON v.category_id = c.id
      ${where}
      GROUP BY c.id, c.name, c.thumbnail_url
      ORDER BY c.name ASC
    `;

    const r = await db.query(sql, params);

    const items = r.rows.map((c) => ({
      ...c,
      thumbnail_url: fixVideoUrls(req, { thumbnail_url: c.thumbnail_url })
        .thumbnail_url,
    }));

    // OPTIMIZATION 5: ETag so browsers can cache & get 304 on repeat requests
    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({ items });
  } catch (e) {
    console.error("[GET /api/public/categories] error:", e);
    res.status(500).json({ message: "Failed to fetch categories" });
  }
});

/* ═══════════════════════════════════════════════════════════
   PUBLIC VIDEOS
   GET /api/public/videos
════════════════════════════════════════════════════════════ */
router.get("/videos", async (req, res) => {
  try {
    // OPTIMIZATION 1 & 2: respect sort params; cap limit properly
    const { search, only_free, sort, sort_by, order, order_by } = req.query;

    const limit = clampInt(req.query.limit ?? req.query.per_page, 1, 500, 100);
    const sortCol = resolveSortCol(sort || sort_by);
    const sortDir = resolveOrder(order || order_by);

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

    params.push(limit);

    // OPTIMIZATION 6: explicit columns instead of v.* — avoids sending blob/binary fields
    const sql = `
      SELECT
        v.id,
        v.title,
        v.description,
        v.thumbnail_url,
        v.duration_seconds,
        v.is_premium,
        v.is_published,
        v.visibility,
        v.category_id,
        v.published_at,
        v.created_at,
        v.updated_at,
        v.views,
        v.bunny_video_id,
        v.video_url,
        v.hls_url,
        c.name AS category_name
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY ${sortCol} ${sortDir} NULLS LAST
      LIMIT $${params.length}
    `;

    const r = await db.query(sql, params);
    const items = r.rows.map((v) => fixVideoUrls(req, v));

    // Short cache — videos change frequently but 304s help with repeat home page loads
    res.set("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    res.json({ items });
  } catch (e) {
    console.error("[GET /api/public/videos] error:", e);
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

/* ═══════════════════════════════════════════════════════════
   PUBLIC PLAYLISTS (legacy)
   GET /api/public/playlists
════════════════════════════════════════════════════════════ */
router.get("/playlists", async (req, res) => {
  try {
    const limit = clampInt(req.query.limit, 1, 200, 24);
    const search = String(req.query.search || "").trim();
    const nonempty = req.query.nonempty !== "0";

    const params = [];
    let idx = 1;

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
        cat.name  AS featured_category_name,
        cat.slug  AS featured_category_slug,
        p.created_at,
        COUNT(v.id)::int                  AS video_count,
        COUNT(v.id)::int                  AS item_count,
        COALESCE(SUM(v.duration_seconds), 0)::int AS duration_total
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
    const items = (r.rows || []).map((p) => fixPlaylistUrls(req, p));

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    res.json({ items });
  } catch (e) {
    console.error("[GET /public/playlists] error", e);
    res.status(500).json({ message: "Failed to load playlists" });
  }
});

module.exports = router;
