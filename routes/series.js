// server-api/routes/series.js — Series / program pages (Uscreen-style)
//
// A series is an ADMIN collection (playlists created by an admin / owner) with
// "Show as a series" switched on — members' own playlists never appear.
//   GET  /api/series                      published series (cover, tagline, episodes, length)
//   GET  /api/series/:idOrSlug            one series + its episodes in order; for a signed-in
//                                         member also their progress and the episode to resume
//   GET  /api/series/admin/:id            (staff) series settings + all episodes
//   PUT  /api/series/admin/:id            (staff) { is_series, tagline, cover_url, trailer_video_id, series_order }
//   PUT  /api/series/admin/:id/order      (staff) { video_ids: [...] }  episode order
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { requireArea } = require("../lib/teamAccess");
const authenticate = require("../middleware/authenticate");

const router = express.Router();
router.use(express.json({ limit: "256kb" }));

let ready = null;
function ensureColumns() {
  if (!ready)
    ready = (async () => {
      for (const sql of [
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS is_series boolean DEFAULT false",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS series_tagline text",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS series_cover_url text",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS series_trailer_video_id integer",
        "ALTER TABLE playlists ADD COLUMN IF NOT EXISTS series_order integer DEFAULT 0",
      ])
        await db.query(sql);
    })().catch((e) => {
      ready = null;
      throw e;
    });
  return ready;
}
router.use(async (_req, res, next) => {
  try {
    await ensureColumns();
    next();
  } catch (e) {
    res.status(500).json({ message: `Database not ready: ${e.message}` });
  }
});

// a signed-in member if a valid token was sent; visitors are fine
function optionalUser(req) {
  try {
    const h = req.headers.authorization || "";
    const raw = h.startsWith("Bearer ")
      ? h.slice(7).trim()
      : (req.get("x-access-token") || req.cookies?.token || "").trim();
    if (!raw || !process.env.JWT_SECRET) return null;
    const p = jwt.verify(raw, process.env.JWT_SECRET);
    return p?.id ? { id: p.id, role: p.role || "user" } : null;
  } catch {
    return null;
  }
}

const PUBLIC_VIDEO = `v.is_published = TRUE AND COALESCE(v.visibility, 'public') <> 'unlisted'`;
// admin collections only (members' playlists excluded)
const ADMIN_OWNED = `(p.created_by IS NULL OR EXISTS (SELECT 1 FROM users u WHERE u.id = p.created_by AND LOWER(COALESCE(u.role,'')) IN ('admin','owner')))`;

const shape = (r) => ({
  id: r.id,
  slug: r.slug || String(r.id),
  title: r.title,
  tagline: r.series_tagline || "",
  description: r.description || "",
  cover_url: r.series_cover_url || r.thumbnail_url || "",
  thumbnail_url: r.thumbnail_url || "",
  episode_count: Number(r.episode_count) || 0,
  total_seconds: Number(r.total_seconds) || 0,
});

router.get("/", async (_req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, x.episode_count, x.total_seconds
         FROM playlists p
         JOIN LATERAL (
           SELECT COUNT(*)::int AS episode_count, COALESCE(SUM(v.duration_seconds), 0)::int AS total_seconds
             FROM playlist_videos pv JOIN videos v ON v.id = pv.video_id
            WHERE pv.playlist_id = p.id AND ${PUBLIC_VIDEO}
         ) x ON TRUE
        WHERE p.is_series = TRUE AND ${ADMIN_OWNED} AND x.episode_count > 0
        ORDER BY p.series_order ASC NULLS LAST, p.title ASC`,
    );
    res.set("Cache-Control", "public, max-age=30");
    res.json({ items: rows.map(shape) });
  } catch (e) {
    console.error("[series] list:", e);
    res.status(500).json({ message: "Failed to load the series" });
  }
});

async function loadSeries(key, { adminView = false } = {}) {
  const { rows } = await db.query(
    `SELECT p.* FROM playlists p
      WHERE (p.id::text = $1 OR p.slug = $1) AND ${ADMIN_OWNED} ${adminView ? "" : "AND p.is_series = TRUE"}
      LIMIT 1`,
    [String(key)],
  );
  return rows[0] || null;
}
async function episodesOf(id, { onlyPublic = true } = {}) {
  const { rows } = await db.query(
    `SELECT v.id, v.title, v.slug, v.thumbnail_url, v.duration_seconds, v.short_description, v.description,
            v.is_published, v.visibility, v.is_premium, pv.sort_index
       FROM playlist_videos pv JOIN videos v ON v.id = pv.video_id
      WHERE pv.playlist_id = $1 ${onlyPublic ? `AND ${PUBLIC_VIDEO}` : ""}
      ORDER BY pv.sort_index ASC NULLS LAST, pv.added_at ASC NULLS LAST`,
    [id],
  );
  return rows;
}

router.get("/:idOrSlug", async (req, res, next) => {
  if (req.params.idOrSlug === "admin") return next();
  try {
    const s = await loadSeries(req.params.idOrSlug);
    if (!s) return res.status(404).json({ message: "Series not found" });
    const eps = await episodesOf(s.id);
    if (!eps.length)
      return res.status(404).json({ message: "Series not found" });
    const user = optionalUser(req);
    let prog = new Map();
    if (user) {
      const { rows } = await db
        .query(
          `SELECT video_id, position_seconds, duration_seconds, completed, updated_at
           FROM watch_progress WHERE user_id = $1 AND video_id = ANY($2::int[])`,
          [user.id, eps.map((e) => e.id)],
        )
        .catch(() => ({ rows: [] }));
      prog = new Map(rows.map((r) => [Number(r.video_id), r]));
    }
    const episodes = eps.map((e, i) => {
      const p = prog.get(Number(e.id));
      const len =
        Number(e.duration_seconds) || Number(p?.duration_seconds) || 0;
      const pos = Number(p?.position_seconds) || 0;
      // "watched" = marked complete, or within the last 5% / 60 s
      const done =
        !!p &&
        (p.completed === true ||
          (len > 0 && pos >= Math.max(len * 0.95, len - 60)));
      return {
        id: e.id,
        number: i + 1,
        title: e.title,
        thumbnail_url: e.thumbnail_url || "",
        duration_seconds: Number(e.duration_seconds) || 0,
        summary:
          e.short_description ||
          String(e.description || "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 220),
        is_premium: !!e.is_premium,
        progress: user
          ? {
              position_seconds: done ? 0 : pos,
              completed: done,
              percent: done
                ? 100
                : len
                  ? Math.min(99, Math.round((pos / len) * 100))
                  : 0,
            }
          : null,
        _updated: p?.updated_at ? new Date(p.updated_at).getTime() : 0,
      };
    });
    // where to continue: the episode in progress most recently watched; else the
    // first unwatched one after the last watched; all watched → from the start
    let resume = null;
    if (user) {
      const inProgress = episodes
        .filter(
          (e) => !e.progress.completed && e.progress.position_seconds >= 15,
        )
        .sort((a, b) => b._updated - a._updated)[0];
      if (inProgress)
        resume = {
          episode_id: inProgress.id,
          number: inProgress.number,
          position_seconds: inProgress.progress.position_seconds,
          kind: "resume",
        };
      else {
        const lastDone = Math.max(
          -1,
          ...episodes.map((e, i) => (e.progress.completed ? i : -1)),
        );
        const next =
          episodes.slice(lastDone + 1).find((e) => !e.progress.completed) ||
          null;
        if (next && lastDone >= 0)
          resume = {
            episode_id: next.id,
            number: next.number,
            position_seconds: 0,
            kind: "next",
          };
        else if (!next && lastDone >= 0)
          resume = {
            episode_id: episodes[0].id,
            number: 1,
            position_seconds: 0,
            kind: "again",
          };
      }
    }
    let trailer = null;
    if (s.series_trailer_video_id) {
      const t = await db.query(
        `SELECT v.id, v.title FROM videos v WHERE v.id = $1 AND ${PUBLIC_VIDEO}`,
        [s.series_trailer_video_id],
      );
      trailer = t.rows[0] || null;
    }
    const total = episodes.reduce((n, e) => n + e.duration_seconds, 0);
    res.set("Cache-Control", user ? "private, no-store" : "public, max-age=30");
    res.json({
      ...shape({ ...s, episode_count: episodes.length, total_seconds: total }),
      trailer,
      episodes: episodes.map(({ _updated, ...e }) => e),
      progress: user
        ? {
            watched: episodes.filter((e) => e.progress.completed).length,
            total: episodes.length,
            resume,
          }
        : null,
    });
  } catch (e) {
    console.error("[series] one:", e);
    res.status(500).json({ message: "Failed to load the series" });
  }
});

/* ---------- staff ---------- */
const staff = [authenticate, requireArea("content", "website")];

router.get("/admin/:id", ...staff, async (req, res) => {
  const s = await loadSeries(req.params.id, { adminView: true });
  if (!s)
    return res
      .status(404)
      .json({
        message: "Collection not found (only admin collections can be series)",
      });
  const eps = await episodesOf(s.id, { onlyPublic: false });
  res.json({
    id: s.id,
    slug: s.slug || String(s.id),
    title: s.title,
    is_series: !!s.is_series,
    tagline: s.series_tagline || "",
    cover_url: s.series_cover_url || "",
    trailer_video_id: s.series_trailer_video_id || null,
    series_order: Number(s.series_order) || 0,
    episodes: eps.map((e, i) => ({
      id: e.id,
      number: i + 1,
      title: e.title,
      thumbnail_url: e.thumbnail_url || "",
      duration_seconds: Number(e.duration_seconds) || 0,
      published: e.is_published === true && e.visibility !== "unlisted",
    })),
  });
});

router.put("/admin/:id", ...staff, async (req, res) => {
  const s = await loadSeries(req.params.id, { adminView: true });
  if (!s)
    return res
      .status(404)
      .json({
        message: "Collection not found (only admin collections can be series)",
      });
  const b = req.body || {};
  const trailer = b.trailer_video_id ? Number(b.trailer_video_id) : null;
  const { rows } = await db.query(
    `UPDATE playlists SET is_series = $2, series_tagline = $3, series_cover_url = $4, series_trailer_video_id = $5, series_order = $6
      WHERE id = $1 RETURNING id, is_series, series_tagline, series_cover_url, series_trailer_video_id, series_order`,
    [
      s.id,
      !!b.is_series,
      String(b.tagline || "").slice(0, 300) || null,
      String(b.cover_url || "").trim() || null,
      Number.isFinite(trailer) ? trailer : null,
      Number(b.series_order) || 0,
    ],
  );
  res.json({ ok: true, series: rows[0] });
});

router.put("/admin/:id/order", ...staff, async (req, res) => {
  const s = await loadSeries(req.params.id, { adminView: true });
  if (!s) return res.status(404).json({ message: "Collection not found" });
  const ids = (Array.isArray(req.body?.video_ids) ? req.body.video_ids : [])
    .map(Number)
    .filter(Number.isFinite);
  const client = typeof db.connect === "function" ? await db.connect() : db;
  try {
    await client.query("BEGIN");
    for (let i = 0; i < ids.length; i += 1)
      await client.query(
        "UPDATE playlist_videos SET sort_index = $3 WHERE playlist_id = $1 AND video_id = $2",
        [s.id, ids[i], i],
      );
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {}
    res.status(500).json({ message: `Could not save the order: ${e.message}` });
  } finally {
    client.release?.();
  }
});

module.exports = router;
