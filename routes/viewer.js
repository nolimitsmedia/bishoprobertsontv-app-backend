// server-api/routes/viewer.js
//
// Release 2.0 Part A — the viewer experience (Netflix / Uscreen style).
//
//   GET    /api/viewer/browse              rows for the Browse page (signed-out: public rows)
//   GET    /api/viewer/list                My List (signed in)
//   GET    /api/viewer/list/ids            ids in My List (for "+ My List" buttons)
//   POST   /api/viewer/list                { video_id } add to My List
//   DELETE /api/viewer/list/:videoId       remove from My List
//   GET    /api/viewer/continue            Continue Watching (signed in)
//   DELETE /api/viewer/continue/:videoId   remove a video from Continue Watching
//
// Continue Watching reads watch_progress (what the player saves); only published
// public videos are shown; columns are detected once so databases that differ
// slightly (e.g. no description column) still work.

const express = require("express");
const router = express.Router();
const db = require("../db");
const { userIdFromToken } = require("../lib/teamAccess");

const ROW_SIZE = 20;

let colsPromise = null;
function videoColumns() {
  if (!colsPromise) {
    colsPromise = db
      .query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'videos' AND table_schema = ANY (current_schemas(false))`,
      )
      .then((r) => new Set(r.rows.map((x) => x.column_name)))
      .catch((e) => {
        colsPromise = null;
        throw e;
      });
  }
  return colsPromise;
}

let listTablePromise = null;
function ensureListTable() {
  if (!listTablePromise) {
    listTablePromise = db
      .query(
        `CREATE TABLE IF NOT EXISTS user_watchlist (
           id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL, video_id INTEGER NOT NULL,
           created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (user_id, video_id))`,
      )
      .catch((e) => {
        listTablePromise = null;
        throw e;
      });
  }
  return listTablePromise;
}

// SELECT list and visibility filter for videos (alias v), built from real columns.
async function videoSql() {
  const c = await videoColumns();
  const col = (name, fallback = "NULL") =>
    c.has(name) ? `v.${name}` : fallback;
  const thumb = c.has("metadata")
    ? `COALESCE(NULLIF(v.thumbnail_url, ''), v.metadata->>'thumbnail_url', v.metadata->>'thumbnail_vertical_url')`
    : col("thumbnail_url");
  const select = [
    "v.id",
    "v.title",
    `LEFT(${col("description", "''")}, 280) AS description`,
    `${thumb} AS thumbnail`,
    `${col("duration_seconds")} AS duration_seconds`,
    `${col("is_premium", "FALSE")} AS is_premium`,
    `${col("published_at", col("created_at"))} AS published_at`,
    `${col("category_id")} AS category_id`,
  ].join(", ");
  const visible = [
    c.has("is_published") ? "v.is_published = TRUE" : "TRUE",
    c.has("visibility") ? "v.visibility = 'public'" : "TRUE",
  ].join(" AND ");
  const newest = c.has("published_at")
    ? "v.published_at DESC NULLS LAST, v.id DESC"
    : "v.id DESC";
  return { select, visible, newest, hasCategory: c.has("category_id") };
}

const shape = (r, extra = {}) => ({
  id: Number(r.id),
  title: r.title || "Untitled",
  description: r.description || "",
  thumbnail: r.thumbnail || "",
  duration_seconds:
    r.duration_seconds == null ? null : Number(r.duration_seconds),
  is_premium: !!r.is_premium,
  published_at: r.published_at,
  ...extra,
});

async function continueRows(userId, sql, limit = ROW_SIZE) {
  try {
    const { rows } = await db.query(
      `SELECT ${sql.select}, wp.position_seconds, COALESCE(NULLIF(wp.duration_seconds, 0), ${
        (await videoColumns()).has("duration_seconds")
          ? "v.duration_seconds"
          : "NULL"
      }) AS progress_duration
         FROM watch_progress wp
         JOIN videos v ON v.id = wp.video_id
        WHERE wp.user_id = $1 AND wp.completed IS NOT TRUE AND wp.position_seconds >= 15 AND ${sql.visible}
        ORDER BY wp.updated_at DESC
        LIMIT $2`,
      [String(userId), limit],
    );
    return rows
      .map((r) => {
        const dur = Number(r.progress_duration) || 0;
        const pos = Number(r.position_seconds) || 0;
        // hide what's essentially finished (last 5%)
        if (dur && pos >= dur * 0.95) return null;
        return shape(r, {
          progress: {
            position: pos,
            duration: dur,
            pct: dur ? Math.min(99, Math.round((pos / dur) * 100)) : null,
          },
        });
      })
      .filter(Boolean);
  } catch (e) {
    if (String(e?.code) === "42P01") return []; // nobody has watched yet
    throw e;
  }
}

async function listRows(userId, sql, limit = 200) {
  await ensureListTable();
  const { rows } = await db.query(
    `SELECT ${sql.select}
       FROM user_watchlist w
       JOIN videos v ON v.id = w.video_id
      WHERE w.user_id = $1 AND ${sql.visible}
      ORDER BY w.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows.map((r) => shape(r));
}

async function featuredPicks() {
  try {
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key = 'site_options'",
    );
    const list = rows[0]?.published_json?.featured;
    return (Array.isArray(list) ? list : [])
      .map((f) => ({
        video_id: Number(f?.video_id),
        image_url: String(f?.image_url || ""),
      }))
      .filter((f) => Number.isSafeInteger(f.video_id) && f.video_id > 0)
      .slice(0, 8);
  } catch {
    return []; // settings table missing: use the newest videos
  }
}

// Escape LIKE wildcards so a search for "100%" means the text "100%".
const likeTerm = (q) => `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

// Global search: videos, categories and collections.
router.get("/search", async (req, res) => {
  const q = String(req.query.q || "")
    .trim()
    .slice(0, 80);
  res.set("Cache-Control", "no-store");
  if (q.length < 2)
    return res.json({
      ok: true,
      q,
      videos: [],
      categories: [],
      collections: [],
    });
  try {
    const sql = await videoSql();
    const cols = await videoColumns();
    const term = likeTerm(q);
    const where = cols.has("description")
      ? `(v.title ILIKE $1 ESCAPE '\\' OR v.description ILIKE $1 ESCAPE '\\')`
      : `v.title ILIKE $1 ESCAPE '\\'`;
    const { rows: vids } = await db.query(
      `SELECT ${sql.select}, (v.title ILIKE $1 ESCAPE '\\') AS in_title
         FROM videos v WHERE ${sql.visible} AND ${where}
        ORDER BY in_title DESC, ${sql.newest} LIMIT 24`,
      [term],
    );
    let categories = [];
    if (sql.hasCategory) {
      try {
        const { rows } = await db.query(
          `SELECT c.id, c.name, COUNT(v.id)::int AS n
             FROM categories c JOIN videos v ON v.category_id = c.id AND ${sql.visible}
            WHERE c.name ILIKE $1 ESCAPE '\\'
            GROUP BY c.id, c.name ORDER BY n DESC LIMIT 6`,
          [term],
        );
        categories = rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          count: r.n,
        }));
      } catch {
        categories = [];
      }
    }
    let collections = [];
    try {
      const { rows } = await db.query(
        `SELECT p.id, p.title, COALESCE(p.slug, '') AS slug, p.thumbnail_url
           FROM playlists p
          WHERE p.visibility = 'public' AND p.title ILIKE $1 ESCAPE '\\'
          ORDER BY p.title LIMIT 6`,
        [term],
      );
      collections = rows.map((r) => ({
        id: Number(r.id),
        title: r.title,
        slug: r.slug,
        thumbnail: r.thumbnail_url || "",
      }));
    } catch {
      collections = []; // no collections table on this site
    }
    res.json({
      ok: true,
      q,
      videos: vids.map((r) => shape(r)),
      categories,
      collections,
    });
  } catch (e) {
    console.error("[viewer] search failed:", e);
    res
      .status(500)
      .json({ ok: false, error: "Search is unavailable right now" });
  }
});

router.get("/browse", async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const userId = userIdFromToken(req);
    const sql = await videoSql();
    const rows = [];

    const { rows: newest } = await db.query(
      `SELECT ${sql.select} FROM videos v WHERE ${sql.visible} ORDER BY ${sql.newest} LIMIT $1`,
      [ROW_SIZE],
    );
    // Featured (hero): chosen in Site Settings › Featured videos; else the newest.
    let featured = [];
    const picks = await featuredPicks();
    if (picks.length) {
      const { rows: fv } = await db.query(
        `SELECT ${sql.select} FROM videos v WHERE ${sql.visible} AND v.id = ANY($1::int[])`,
        [picks.map((p) => p.video_id)],
      );
      const byId = new Map(fv.map((r) => [Number(r.id), r]));
      featured = picks
        .map(
          (p) =>
            byId.get(p.video_id) &&
            shape(byId.get(p.video_id), { hero_image: p.image_url || "" }),
        )
        .filter(Boolean);
    }
    if (!featured.length)
      featured = newest
        .filter((r) => r.thumbnail)
        .slice(0, 5)
        .map((r) => shape(r));

    if (userId) {
      const cont = await continueRows(userId, sql);
      if (cont.length)
        rows.push({ key: "continue", title: "Continue Watching", items: cont });
      const list = await listRows(userId, sql, ROW_SIZE);
      if (list.length)
        rows.push({ key: "my-list", title: "My List", items: list });
    }
    if (newest.length)
      rows.push({
        key: "new",
        title: "New Releases",
        items: newest.map((r) => shape(r)),
      });

    if (sql.hasCategory) {
      // Categories with the most public videos, each newest first.
      const { rows: cats } = await db.query(
        `SELECT c.id, c.name, COUNT(*)::int AS n
           FROM videos v JOIN categories c ON c.id = v.category_id
          WHERE ${sql.visible}
          GROUP BY c.id, c.name
          HAVING COUNT(*) > 0
          ORDER BY n DESC, c.name ASC
          LIMIT 8`,
      );
      for (const cat of cats) {
        const { rows: vids } = await db.query(
          `SELECT ${sql.select} FROM videos v WHERE ${sql.visible} AND v.category_id = $1 ORDER BY ${sql.newest} LIMIT $2`,
          [cat.id, ROW_SIZE],
        );
        if (vids.length)
          rows.push({
            key: `category-${cat.id}`,
            title: cat.name,
            category_id: Number(cat.id),
            total: cat.n,
            items: vids.map((r) => shape(r)),
          });
      }
    }
    res.json({ ok: true, signed_in: !!userId, featured, rows });
  } catch (e) {
    console.error("[viewer] browse failed:", e);
    res.status(500).json({ ok: false, error: "Unable to load videos" });
  }
});

// ---- signed-in only ----
function requireViewer(req, res, next) {
  const id = userIdFromToken(req);
  if (!id)
    return res.status(401).json({ ok: false, error: "Sign in to use My List" });
  req.viewerId = id;
  next();
}

router.get("/list", requireViewer, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      items: await listRows(req.viewerId, await videoSql()),
    });
  } catch (e) {
    console.error("[viewer] list failed:", e);
    res.status(500).json({ ok: false, error: "Unable to load My List" });
  }
});

router.get("/list/ids", requireViewer, async (req, res) => {
  try {
    await ensureListTable();
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      "SELECT video_id FROM user_watchlist WHERE user_id = $1",
      [req.viewerId],
    );
    res.json({ ok: true, ids: rows.map((r) => Number(r.video_id)) });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Unable to load My List" });
  }
});

router.post("/list", express.json(), requireViewer, async (req, res) => {
  const vid = Number.parseInt(req.body?.video_id, 10);
  if (!Number.isSafeInteger(vid) || vid <= 0)
    return res.status(400).json({ ok: false, error: "Choose a video" });
  try {
    const sql = await videoSql();
    const { rows } = await db.query(
      `SELECT 1 FROM videos v WHERE v.id = $1 AND ${sql.visible}`,
      [vid],
    );
    if (!rows.length)
      return res
        .status(404)
        .json({ ok: false, error: "This video is not available" });
    await ensureListTable();
    const { rows: count } = await db.query(
      "SELECT COUNT(*)::int AS n FROM user_watchlist WHERE user_id = $1",
      [req.viewerId],
    );
    if (count[0].n >= 500)
      return res
        .status(400)
        .json({ ok: false, error: "My List is full (500 videos)" });
    await db.query(
      "INSERT INTO user_watchlist (user_id, video_id) VALUES ($1, $2) ON CONFLICT (user_id, video_id) DO NOTHING",
      [req.viewerId, vid],
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[viewer] add failed:", e);
    res.status(500).json({ ok: false, error: "Could not add to My List" });
  }
});

router.delete("/list/:videoId", requireViewer, async (req, res) => {
  const vid = Number.parseInt(req.params.videoId, 10);
  if (!Number.isSafeInteger(vid))
    return res.status(400).json({ ok: false, error: "Invalid video" });
  try {
    await ensureListTable();
    await db.query(
      "DELETE FROM user_watchlist WHERE user_id = $1 AND video_id = $2",
      [req.viewerId, vid],
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Could not remove from My List" });
  }
});

router.get("/continue", requireViewer, async (req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      items: await continueRows(req.viewerId, await videoSql(), 50),
    });
  } catch (e) {
    console.error("[viewer] continue failed:", e);
    res
      .status(500)
      .json({ ok: false, error: "Unable to load Continue Watching" });
  }
});

// "Remove from row": the video is treated as finished (resume starts over).
router.delete("/continue/:videoId", requireViewer, async (req, res) => {
  const vid = Number.parseInt(req.params.videoId, 10);
  if (!Number.isSafeInteger(vid))
    return res.status(400).json({ ok: false, error: "Invalid video" });
  try {
    await db.query(
      "UPDATE watch_progress SET completed = TRUE, position_seconds = 0, updated_at = NOW() WHERE user_id = $1 AND video_id = $2",
      [String(req.viewerId), vid],
    );
    res.json({ ok: true });
  } catch (e) {
    if (String(e?.code) === "42P01") return res.json({ ok: true });
    res
      .status(500)
      .json({ ok: false, error: "Could not update Continue Watching" });
  }
});

module.exports = router;
