// server-api/routes/adminDashboard.js
const express = require("express");
const router = express.Router();

/**
 * Helpers to safely detect columns (so this works even if your schema differs).
 */
async function hasColumn(db, table, column) {
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
  `;
  const r = await db.query(q, [table, column]);
  return r.rowCount > 0;
}

async function pickFirstExistingColumn(db, table, candidates) {
  for (const col of candidates) {
    // allow raw expressions
    if (col.includes("(") || col.includes(" ") || col.includes("::"))
      return col;
    // check real column
    // eslint-disable-next-line no-await-in-loop
    if (await hasColumn(db, table, col)) return col;
  }
  return null;
}

router.get("/overview", async (req, res) => {
  try {
    const db = req.db;

    // ---- USERS ----
    const usersTable = "users";
    const userCreatedCol = await pickFirstExistingColumn(db, usersTable, [
      "created_at",
      "createdAt",
      "date_created",
      "registered_at",
    ]);

    const usersTotalSql = `SELECT COUNT(*)::int AS n FROM ${usersTable}`;
    const usersTotal = (await db.query(usersTotalSql)).rows[0]?.n || 0;

    let newToday = 0,
      new7d = 0,
      new30d = 0;

    if (userCreatedCol) {
      const usersNewSql = `
        SELECT
          COUNT(*) FILTER (WHERE ${userCreatedCol} >= date_trunc('day', now()))::int AS today,
          COUNT(*) FILTER (WHERE ${userCreatedCol} >= now() - interval '7 days')::int AS d7,
          COUNT(*) FILTER (WHERE ${userCreatedCol} >= now() - interval '30 days')::int AS d30
        FROM ${usersTable}
      `;
      const u = (await db.query(usersNewSql)).rows[0] || {};
      newToday = u.today || 0;
      new7d = u.d7 || 0;
      new30d = u.d30 || 0;
    }

    // ---- VIDEOS ----
    const videosTable = "videos";

    const videoTitleCol = await pickFirstExistingColumn(db, videosTable, [
      "title",
      "name",
    ]);

    const videoThumbCol = await pickFirstExistingColumn(db, videosTable, [
      "thumbnail_url",
      "thumbnailUrl",
      "thumb_url",
      "thumbnail",
      "poster",
      "image_url",
      "cover_url",
    ]);

    const videoCreatedCol = await pickFirstExistingColumn(db, videosTable, [
      "published_at",
      "publishedAt",
      "created_at",
      "createdAt",
    ]);

    const videoCategoryCol = await pickFirstExistingColumn(db, videosTable, [
      "category_id",
      "categoryId",
    ]);

    const videoStatusCol = await pickFirstExistingColumn(db, videosTable, [
      "status",
    ]);

    const videoPublishedBoolCol = await pickFirstExistingColumn(
      db,
      videosTable,
      ["is_published", "published"]
    );

    // Determine "published" expression
    // Priority: boolean flags > status string. If none exist, assume published.
    let isPublishedExpr = "true";
    if (videoPublishedBoolCol) {
      isPublishedExpr = `${videoPublishedBoolCol} = true`;
    } else if (videoStatusCol) {
      isPublishedExpr = `LOWER(${videoStatusCol}) = 'published'`;
    }

    const videosTotalSql = `SELECT COUNT(*)::int AS n FROM ${videosTable}`;
    const videosTotal = (await db.query(videosTotalSql)).rows[0]?.n || 0;

    const videosHealthSql = `
      SELECT
        COUNT(*) FILTER (WHERE NOT (${isPublishedExpr}))::int AS not_published,
        COUNT(*) FILTER (WHERE ${
          videoThumbCol
            ? `${videoThumbCol} IS NULL OR ${videoThumbCol} = ''`
            : "false"
        })::int AS missing_thumbnails,
        COUNT(*) FILTER (WHERE ${
          videoCategoryCol ? `${videoCategoryCol} IS NULL` : "false"
        })::int AS missing_categories
      FROM ${videosTable}
    `;
    const health = (await db.query(videosHealthSql)).rows[0] || {};

    // Recently published
    const recentSql = `
      SELECT
        id,
        ${videoTitleCol ? `${videoTitleCol} AS title` : `'Untitled' AS title`},
        ${videoThumbCol ? `${videoThumbCol} AS thumb` : `NULL AS thumb`},
        ${videoCreatedCol ? `${videoCreatedCol} AS date` : `NULL AS date`}
      FROM ${videosTable}
      ORDER BY ${
        videoCreatedCol ? `${videoCreatedCol} DESC NULLS LAST` : "id DESC"
      }
      LIMIT 8
    `;
    const recent = (await db.query(recentSql)).rows || [];

    // ---- CATEGORIES ----
    const categoriesTable = "categories";
    const catNameCol = await pickFirstExistingColumn(db, categoriesTable, [
      "name",
      "title",
      "label",
    ]);

    let topCategories = [];
    if (videoCategoryCol) {
      const topCatsSql = `
        SELECT
          c.id,
          ${catNameCol ? `c.${catNameCol} AS name` : `'Category' AS name`},
          COUNT(v.id)::int AS count
        FROM ${categoriesTable} c
        LEFT JOIN ${videosTable} v
          ON v.${videoCategoryCol} = c.id
        GROUP BY c.id ${catNameCol ? `, c.${catNameCol}` : ""}
        ORDER BY COUNT(v.id) DESC
        LIMIT 8
      `;
      topCategories = (await db.query(topCatsSql)).rows || [];
    }

    return res.json({
      ok: true,
      users: {
        total: usersTotal,
        new_today: newToday,
        new_7d: new7d,
        new_30d: new30d,
      },
      content: {
        total_videos: videosTotal,
        recently_published: recent,
        top_categories: topCategories,
      },
      health: {
        missing_thumbnails: health.missing_thumbnails || 0,
        missing_categories: health.missing_categories || 0,
        not_published: health.not_published || 0,
      },
    });
  } catch (e) {
    console.error("[adminDashboard] overview error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
