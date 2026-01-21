// server-api/routes/collections.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function isDigits(x) {
  return typeof x === "string" && /^\d+$/.test(x);
}

/* =========================
   PUBLIC ENDPOINTS
   ========================= */

/**
 * GET /api/collections/public
 * Public list of collections that actually contain at least 1 published video.
 */
router.get("/public", async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200,
    );
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();

    const params = [];
    let p = 1;

    let where = `
      WHERE EXISTS (
        SELECT 1
        FROM collection_videos cv
        JOIN videos v ON v.id = cv.video_id
        WHERE cv.collection_id = c.id
          AND v.is_published = TRUE
          AND v.visibility <> 'unlisted'
      )
    `;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.title ILIKE $${p} OR c.description ILIKE $${p})`;
      p++;
    }

    const rows = await db.query(
      `
      SELECT
        c.*,
        (
          SELECT COUNT(*)::int
          FROM collection_videos cv
          JOIN videos v ON v.id = cv.video_id
          WHERE cv.collection_id = c.id
            AND v.is_published = TRUE
            AND v.visibility <> 'unlisted'
        ) AS video_count
      FROM collections c
      ${where}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
      `,
      params,
    );

    const count = await db.query(
      `
      SELECT COUNT(*)::int AS total
      FROM collections c
      ${where}
      `,
      params,
    );

    res.json({
      items: rows.rows,
      total: count.rows[0]?.total || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error("[GET /collections/public] error:", err);
    res.status(500).json({ message: "Failed to fetch public collections" });
  }
});

/**
 * GET /api/collections/public/:idOrSlug
 */
router.get("/public/:idOrSlug", async (req, res) => {
  try {
    const key = req.params.idOrSlug;

    const q = await db.query(
      `
      SELECT c.*,
        (
          SELECT COUNT(*)::int
          FROM collection_videos cv
          JOIN videos v ON v.id = cv.video_id
          WHERE cv.collection_id = c.id
            AND v.is_published = TRUE
            AND v.visibility <> 'unlisted'
        ) AS video_count
      FROM collections c
      WHERE (c.id::text = $1 OR c.slug = $1)
      LIMIT 1
      `,
      [key],
    );

    if (!q.rows[0]) return res.status(404).json({ message: "Not found" });

    // Only expose if it contains at least one published video
    if (!(Number(q.rows[0].video_count || 0) > 0)) {
      return res.status(404).json({ message: "Not found" });
    }

    res.json(q.rows[0]);
  } catch (err) {
    console.error("[GET /collections/public/:idOrSlug] error:", err);
    res.status(500).json({ message: "Failed to fetch public collection" });
  }
});

/**
 * GET /api/collections/public/:idOrSlug/videos
 * Public list of videos within the collection (published only).
 */
router.get("/public/:idOrSlug/videos", async (req, res) => {
  try {
    const key = req.params.idOrSlug;

    const c = await db.query(
      `SELECT id FROM collections WHERE (id::text = $1 OR slug = $1) LIMIT 1`,
      [key],
    );
    if (!c.rows[0]) return res.status(404).json({ message: "Not found" });

    const collectionId = c.rows[0].id;

    const rows = await db.query(
      `
      SELECT v.*, cv.position
      FROM collection_videos cv
      JOIN videos v ON v.id = cv.video_id
      WHERE cv.collection_id = $1
        AND v.is_published = TRUE
        AND v.visibility <> 'unlisted'
      ORDER BY cv.position ASC, v.created_at DESC
      `,
      [collectionId],
    );

    res.json(rows.rows);
  } catch (err) {
    console.error("[GET /collections/public/:idOrSlug/videos] error:", err);
    res
      .status(500)
      .json({ message: "Failed to fetch public collection videos" });
  }
});

/* =========================
   ADMIN (AUTH) ENDPOINTS
   ========================= */

// GET /api/collections?search=&page=&limit=
router.get("/", authenticate, async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page || "1", 10), 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit || "50", 10), 1),
      200,
    );
    const offset = (page - 1) * limit;
    const search = (req.query.search || "").trim();

    const where = [];
    const params = [];
    let p = 1;

    if (search) {
      where.push(`(title ILIKE $${p} OR description ILIKE $${p})`);
      params.push(`%${search}%`);
      p++;
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await db.query(
      `SELECT c.*, COUNT(cv.video_id)::int as video_count
       FROM collections c
       LEFT JOIN collection_videos cv ON cv.collection_id = c.id
       ${whereSql}
       GROUP BY c.id
       ORDER BY c.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`,
      params,
    );

    const count = await db.query(
      `SELECT COUNT(*)::int AS total FROM collections ${whereSql}`,
      params,
    );

    res.json({ items: rows.rows, total: count.rows[0].total, page, limit });
  } catch (err) {
    console.error("[GET /collections] error:", err);
    res.status(500).json({ message: "Failed to fetch collections" });
  }
});

// GET /api/collections/:id
router.get("/:id", authenticate, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT * FROM collections WHERE id = $1 LIMIT 1`,
      [req.params.id],
    );
    if (!q.rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(q.rows[0]);
  } catch (err) {
    console.error("[GET /collections/:id] error:", err);
    res.status(500).json({ message: "Failed to fetch collection" });
  }
});

// GET /api/collections/:id/videos
router.get("/:id/videos", authenticate, async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT v.*, cv.position
       FROM collection_videos cv
       JOIN videos v ON v.id = cv.video_id
       WHERE cv.collection_id = $1
       ORDER BY cv.position ASC, v.created_at DESC`,
      [req.params.id],
    );
    res.json(rows.rows);
  } catch (err) {
    console.error("[GET /collections/:id/videos] error:", err);
    res.status(500).json({ message: "Failed to fetch collection videos" });
  }
});

// POST /api/collections
router.post("/", authenticate, async (req, res) => {
  try {
    const { title, description, slug } = req.body || {};
    if (!title) return res.status(400).json({ message: "title required" });

    const ins = await db.query(
      `INSERT INTO collections(title, slug, description)
       VALUES ($1, $2, $3) RETURNING *`,
      [title, slug ? slugify(slug) : slugify(title), description || null],
    );
    res.json(ins.rows[0]);
  } catch (err) {
    console.error("[POST /collections] error:", err);
    res.status(500).json({ message: "Failed to create collection" });
  }
});

// PUT /api/collections/:id
router.put("/:id", authenticate, async (req, res) => {
  try {
    const { title, description, slug } = req.body || {};
    const q = await db.query(
      `UPDATE collections SET
        title = COALESCE($1, title),
        slug = COALESCE($2, slug),
        description = COALESCE($3, description)
       WHERE id = $4
       RETURNING *`,
      [
        title ?? null,
        slug ? slugify(slug) : null,
        description ?? null,
        req.params.id,
      ],
    );
    if (!q.rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(q.rows[0]);
  } catch (err) {
    console.error("[PUT /collections/:id] error:", err);
    res.status(500).json({ message: "Failed to update collection" });
  }
});

// DELETE /api/collections/:id
router.delete("/:id", authenticate, async (req, res) => {
  try {
    const del = await db.query(
      `DELETE FROM collections WHERE id = $1 RETURNING id`,
      [req.params.id],
    );
    if (!del.rows[0]) return res.status(404).json({ message: "Not found" });
    res.json({ message: "Deleted", id: del.rows[0].id });
  } catch (err) {
    console.error("[DELETE /collections/:id] error:", err);
    res.status(500).json({ message: "Failed to delete collection" });
  }
});

// POST /api/collections/:id/videos   { video_id }
router.post("/:id/videos", authenticate, async (req, res) => {
  try {
    const { video_id } = req.body || {};
    if (!video_id)
      return res.status(400).json({ message: "video_id required" });

    const cur = await db.query(
      `SELECT COALESCE(MAX(position), 0)+1 AS pos
       FROM collection_videos WHERE collection_id = $1`,
      [req.params.id],
    );
    const pos = cur.rows[0].pos || 1;

    await db.query(
      `INSERT INTO collection_videos (collection_id, video_id, position)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection_id, video_id) DO NOTHING`,
      [req.params.id, video_id, pos],
    );
    res.json({ message: "Added", position: pos });
  } catch (err) {
    console.error("[POST /collections/:id/videos] error:", err);
    res.status(500).json({ message: "Failed to add video to collection" });
  }
});

// DELETE /api/collections/:id/videos/:video_id
router.delete("/:id/videos/:video_id", authenticate, async (req, res) => {
  try {
    await db.query(
      `DELETE FROM collection_videos WHERE collection_id = $1 AND video_id = $2`,
      [req.params.id, req.params.video_id],
    );
    res.json({ message: "Removed" });
  } catch (err) {
    console.error("[DELETE /collections/:id/videos/:video_id] error:", err);
    res.status(500).json({ message: "Failed to remove video" });
  }
});

// PUT /api/collections/:id/reorder   { video_ids: [..] }
router.put("/:id/reorder", authenticate, async (req, res) => {
  try {
    const { video_ids } = req.body || {};
    if (!Array.isArray(video_ids)) {
      return res.status(400).json({ message: "video_ids array required" });
    }
    for (let i = 0; i < video_ids.length; i++) {
      await db.query(
        `UPDATE collection_videos SET position = $1
         WHERE collection_id = $2 AND video_id = $3`,
        [i + 1, req.params.id, video_ids[i]],
      );
    }
    res.json({ message: "Reordered" });
  } catch (err) {
    console.error("[PUT /collections/:id/reorder] error:", err);
    res.status(500).json({ message: "Failed to reorder" });
  }
});

module.exports = router;
