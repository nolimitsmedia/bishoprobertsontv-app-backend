// server-api/routes/adminDashboard.js
const express = require("express");
const router = express.Router();
const { requireArea, TEAM_ROLES } = require("../lib/teamAccess");

// Staff only (any team role or administrator). This route used to be open to
// anyone who knew the address.
router.use(requireArea(...TEAM_ROLES));

// A video "has a thumbnail" when the Catalog can show one: the main field or
// the thumbnails saved in its details (metadata).
const HAS_THUMB = `COALESCE(NULLIF(v.thumbnail_url, ''), NULLIF(v.metadata->>'thumbnail_url', ''), NULLIF(v.metadata->>'thumbnail_vertical_url', '')) IS NOT NULL`;

/**
 * Helpers to safely detect columns (so this works even if your schema differs).
 * Column lookups are cached in memory so the dashboard does not repeatedly hit
 * information_schema on every request.
 */
const columnExistsCache = new Map();

async function hasColumn(db, table, column) {
  const cacheKey = `${table}.${column}`;
  if (columnExistsCache.has(cacheKey)) return columnExistsCache.get(cacheKey);
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
  `;
  const r = await db.query(q, [table, column]);
  const exists = r.rowCount > 0;
  columnExistsCache.set(cacheKey, exists);
  return exists;
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
      ["is_published", "published"],
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
          videoThumbCol === "thumbnail_url" &&
          (await hasColumn(db, videosTable, "metadata"))
            ? `NOT (${HAS_THUMB})`
            : videoThumbCol
              ? `${videoThumbCol} IS NULL OR ${videoThumbCol} = ''`
              : "false"
        })::int AS missing_thumbnails,
        COUNT(*) FILTER (WHERE ${
          videoCategoryCol ? `${videoCategoryCol} IS NULL` : "false"
        })::int AS missing_categories
      FROM ${videosTable} v
    `;
    const health = (await db.query(videosHealthSql)).rows[0] || {};

    // ---- TRENDS (last 30 days vs the 30 before) ----
    const safe = async (sql, params = []) => {
      try {
        return (await db.query(sql, params)).rows;
      } catch {
        return [];
      }
    };
    const days30 = `generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') AS d(day)`;
    let usersDaily = [];
    let usersPrev30 = 0;
    if (userCreatedCol) {
      usersDaily = await safe(
        `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(u.*)::int AS n
           FROM ${days30} LEFT JOIN ${usersTable} u ON date_trunc('day', u.${userCreatedCol}) = d.day
          GROUP BY d.day ORDER BY d.day`,
      );
      usersPrev30 =
        (
          await safe(
            `SELECT COUNT(*)::int AS n FROM ${usersTable}
          WHERE ${userCreatedCol} >= now() - interval '60 days' AND ${userCreatedCol} < now() - interval '30 days'`,
          )
        )[0]?.n || 0;
    }
    let published30 = 0;
    let publishedPrev30 = 0;
    let videosMonthly = [];
    if (videoCreatedCol) {
      const r =
        (
          await safe(
            `SELECT COUNT(*) FILTER (WHERE ${videoCreatedCol} >= now() - interval '30 days' AND ${videoCreatedCol} <= now())::int AS a,
                COUNT(*) FILTER (WHERE ${videoCreatedCol} >= now() - interval '60 days' AND ${videoCreatedCol} < now() - interval '30 days')::int AS b
           FROM ${videosTable}`,
          )
        )[0] || {};
      published30 = r.a || 0;
      publishedPrev30 = r.b || 0;
      videosMonthly = await safe(
        `SELECT to_char(m.month, 'YYYY-MM') AS month, COUNT(v.id)::int AS n
           FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') AS m(month)
           LEFT JOIN ${videosTable} v ON date_trunc('month', v.${videoCreatedCol}) = m.month
          GROUP BY m.month ORDER BY m.month`,
      );
    }
    // plays (Analytics events); empty if this site has no analytics table
    const playsDaily = await safe(
      `SELECT to_char(d.day, 'YYYY-MM-DD') AS day, COUNT(e.*)::int AS n
         FROM ${days30} LEFT JOIN analytics_events e ON e.event_type = 'video_play' AND date_trunc('day', e.created_at) = d.day
        GROUP BY d.day ORDER BY d.day`,
    );
    const playsAgg =
      (
        await safe(
          `SELECT COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS a,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '60 days' AND created_at < now() - interval '30 days')::int AS b,
              COUNT(DISTINCT user_id) FILTER (WHERE created_at >= now() - interval '30 days')::int AS viewers
         FROM analytics_events WHERE event_type = 'video_play'`,
        )
      )[0] || null;

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
        prev_30d: usersPrev30,
      },
      plays: playsAgg
        ? {
            last_30d: playsAgg.a || 0,
            prev_30d: playsAgg.b || 0,
            viewers_30d: playsAgg.viewers || 0,
          }
        : null,
      series: {
        users_daily: usersDaily,
        plays_daily: playsDaily,
        videos_monthly: videosMonthly,
      },
      content: {
        total_videos: videosTotal,
        published_30d: published30,
        published_prev_30d: publishedPrev30,
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

// ---- Which videos? (Content health lists) ----
//   GET /content-health/thumbnails | categories | unpublished
router.get("/content-health/:type", async (req, res) => {
  const type = String(req.params.type || "");
  const where = {
    thumbnails: `NOT (${HAS_THUMB})`,
    categories: "v.category_id IS NULL",
    unpublished: "v.is_published IS NOT TRUE",
  }[type];
  if (!where)
    return res.status(400).json({ ok: false, message: "Unknown list" });
  try {
    const { rows } = await req.db.query(
      `SELECT v.id, v.title, v.is_published, v.visibility, v.category_id, c.name AS category_name,
              COALESCE(NULLIF(v.thumbnail_url, ''), v.metadata->>'thumbnail_url') AS thumb,
              COALESCE(v.published_at, v.created_at) AS date
         FROM videos v LEFT JOIN categories c ON c.id = v.category_id
        WHERE ${where}
        ORDER BY COALESCE(v.published_at, v.created_at) DESC NULLS LAST, v.id DESC
        LIMIT 500`,
    );
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, type, items: rows });
  } catch (e) {
    console.error("[adminDashboard] content-health error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
