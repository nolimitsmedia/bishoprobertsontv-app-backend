// server-api/routes/adminOrganize.js
const express = require("express");
const router = express.Router();
const pool = require("../db");
const requireAdmin = require("../middleware/auth"); // kept for consistency, even if not used directly

/**
 * GET /api/admin/organize/overview
 * High-level collections + all videos (used for initial load).
 */
router.get("/overview", async (req, res) => {
  try {
    const catSql = `
      SELECT
        c.id,
        c.name,
        0::int AS sort_order,
        COUNT(v.id) AS video_count,
        COALESCE(
          SUM(CASE WHEN v.is_published = true THEN 1 ELSE 0 END),
          0
        ) AS published_count
      FROM categories AS c
      LEFT JOIN videos AS v
        ON v.category_id = c.id
      GROUP BY c.id, c.name
      ORDER BY c.name ASC;
    `;
    const { rows: categories } = await pool.query(catSql);

    const videosSql = `
      SELECT
        v.id,
        v.title,
        v.category_id,
        v.visibility,
        v.is_published,
        v.created_at,
        v.sort_order
      FROM videos AS v
      ORDER BY
        v.category_id NULLS FIRST,
        v.sort_order NULLS LAST,
        v.created_at DESC;
    `;
    const { rows: videos } = await pool.query(videosSql);

    res.json({
      ok: true,
      categories,
      collections: categories, // alias for frontend
      videos,
    });
  } catch (err) {
    console.error("adminOrganize overview error:", err);
    res.status(500).json({
      ok: false,
      error: "Failed to load organize overview.",
    });
  }
});

/**
 * GET /api/admin/organize/category/:categoryId/videos
 * Used when you click a collection in the Organize UI.
 */
router.get("/category/:categoryId/videos", async (req, res) => {
  const { categoryId } = req.params;

  try {
    let rows;

    if (categoryId === "uncategorized") {
      // Special case: videos with no category
      const sql = `
        SELECT
          v.id,
          v.title,
          v.category_id,
          v.visibility,
          v.is_published,
          v.created_at,
          v.sort_order
        FROM videos AS v
        WHERE v.category_id IS NULL
        ORDER BY
          v.sort_order NULLS LAST,
          v.created_at DESC;
      `;
      ({ rows } = await pool.query(sql));
    } else {
      const id = parseInt(categoryId, 10);
      if (!Number.isFinite(id)) {
        return res
          .status(400)
          .json({ ok: false, error: "Invalid category id." });
      }

      const sql = `
        SELECT
          v.id,
          v.title,
          v.category_id,
          v.visibility,
          v.is_published,
          v.created_at,
          v.sort_order
        FROM videos AS v
        WHERE v.category_id = $1
        ORDER BY
          v.sort_order NULLS LAST,
          v.created_at DESC;
      `;
      ({ rows } = await pool.query(sql, [id]));
    }

    res.json({ ok: true, videos: rows });
  } catch (err) {
    console.error("adminOrganize category videos error:", err);
    res.status(500).json({
      ok: false,
      error: "Failed to load videos for this category.",
    });
  }
});

/**
 * PUT /api/admin/organize/video-category
 * Body: { videoId, categoryId }
 * Moves a video in/out of a category.
 */
router.put("/video-category", async (req, res) => {
  const { videoId, categoryId } = req.body || {};

  if (!videoId) {
    return res.status(400).json({ ok: false, error: "Missing videoId." });
  }

  try {
    const sql = `
      UPDATE videos
      SET category_id = $1
      WHERE id = $2
      RETURNING id, title, category_id, visibility, is_published, sort_order;
    `;
    const { rows } = await pool.query(sql, [categoryId || null, videoId]);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Video not found." });
    }

    res.json({ ok: true, video: rows[0] });
  } catch (err) {
    console.error("adminOrganize video-category error:", err);
    res
      .status(500)
      .json({ ok: false, error: "Failed to update video category." });
  }
});

/**
 * PUT /api/admin/organize/video-visibility
 * Body: { videoId, is_published, visibility }
 * Toggles publish & access (Public / Members / Admin).
 */
router.put("/video-visibility", async (req, res) => {
  const { videoId, is_published, visibility } = req.body || {};

  if (!videoId) {
    return res.status(400).json({ ok: false, error: "Missing videoId." });
  }

  try {
    const fields = [];
    const params = [];
    let idx = 1;

    if (typeof is_published === "boolean") {
      fields.push(`is_published = $${idx++}`);
      params.push(is_published);
    }
    if (visibility) {
      fields.push(`visibility = $${idx++}`);
      params.push(visibility);
    }

    if (!fields.length) {
      return res.status(400).json({
        ok: false,
        error: "No visibility fields provided.",
      });
    }

    params.push(videoId);
    const sql = `
      UPDATE videos
      SET ${fields.join(", ")}
      WHERE id = $${idx}
      RETURNING id, title, category_id, visibility, is_published, sort_order;
    `;

    const { rows } = await pool.query(sql, params);

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Video not found." });
    }

    res.json({ ok: true, video: rows[0] });
  } catch (err) {
    console.error("adminOrganize video-visibility error:", err);
    res
      .status(500)
      .json({ ok: false, error: "Failed to update video visibility." });
  }
});

/**
 * PUT /api/admin/organize/videos/reorder
 * Body: { items: [{ id, sort_order }, ...] }
 * Saves the manual order for videos in a collection.
 */
router.put("/videos/reorder", async (req, res) => {
  const { items } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res
      .status(400)
      .json({ ok: false, message: "No items provided for reordering." });
  }

  try {
    // Start transaction
    await pool.query("BEGIN");

    for (const row of items) {
      const id = Number(row.id);
      const sortOrder = Number(row.sort_order);

      if (!id || !Number.isFinite(sortOrder)) continue;

      await pool.query(
        `
          UPDATE videos
          SET sort_order = $1
          WHERE id = $2
        `,
        [sortOrder, id]
      );
    }

    await pool.query("COMMIT");

    return res.json({ ok: true });
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("adminOrganize rollback error:", rollbackErr);
    }

    console.error("adminOrganize reorder error:", err);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to save video order." });
  }
});

module.exports = router;
