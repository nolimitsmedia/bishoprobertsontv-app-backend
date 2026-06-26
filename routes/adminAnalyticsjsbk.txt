// server-api/routes/adminAnalytics.js
const router = require("express").Router();
const db = require("../db");

const { requireAuth, requireAdmin } = require("../middleware/auth"); // ✅ declared ONCE

function parseDateParam(s, fallbackDaysAgo) {
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date();
  d.setDate(d.getDate() - fallbackDaysAgo);
  return d.toISOString().slice(0, 10);
}

function pingSecondsFromReq(req) {
  const n = Number(req.query.ping_seconds || 15);
  if (!Number.isFinite(n)) return 15;
  return Math.max(5, Math.min(60, Math.floor(n)));
}

router.get("/overview", requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from, 29);
    const to = parseDateParam(req.query.to, 0);
    const pingSeconds = pingSecondsFromReq(req);

    const r = await db.query(
      `
      WITH base AS (
        SELECT *
        FROM analytics_events
        WHERE created_at >= ($1::date)
          AND created_at <  (($2::date) + INTERVAL '1 day')
      )
      SELECT
        COUNT(*) FILTER (WHERE event_type='video_play')::int AS plays,
        COUNT(DISTINCT user_id)::int AS unique_viewers,
        COUNT(*) FILTER (WHERE event_type='video_progress')::int AS progress_events,
        COUNT(*) FILTER (WHERE event_type='video_complete')::int AS completions
      FROM base
      `,
      [from, to]
    );

    const row = r.rows[0] || {};
    const plays = Number(row.plays || 0);
    const unique = Number(row.unique_viewers || 0);
    const progressEvents = Number(row.progress_events || 0);
    const completions = Number(row.completions || 0);

    const watchSeconds = progressEvents * pingSeconds;

    res.json({
      ok: true,
      range: { from, to },
      ping_seconds: pingSeconds,
      cards: {
        plays,
        unique_viewers: unique,
        watch_seconds: watchSeconds,
        watch_minutes: Math.round(watchSeconds / 60),
        completions,
        completion_rate:
          plays > 0 ? Math.round((completions / plays) * 100) : 0,
        avg_watch_seconds_per_play:
          plays > 0 ? Math.round(watchSeconds / plays) : 0,
      },
    });
  } catch (err) {
    console.error("GET /api/admin/analytics/overview error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.get("/timeseries", requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from, 29);
    const to = parseDateParam(req.query.to, 0);
    const metric = String(req.query.metric || "plays");
    const pingSeconds = pingSecondsFromReq(req);

    let selectExpr;
    let params = [from, to];

    if (metric === "plays") {
      selectExpr = `COUNT(*) FILTER (WHERE event_type='video_play')::int AS value`;
    } else if (metric === "unique_viewers") {
      selectExpr = `COUNT(DISTINCT user_id)::int AS value`;
    } else if (metric === "watch_time") {
      selectExpr = `(COUNT(*) FILTER (WHERE event_type='video_progress')::bigint * $3::bigint) AS value`;
      params = [from, to, pingSeconds];
    } else {
      return res.status(400).json({ ok: false, error: "Invalid metric" });
    }

    const r = await db.query(
      `
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS day,
        ${selectExpr}
      FROM analytics_events
      WHERE created_at >= ($1::date)
        AND created_at <  (($2::date) + INTERVAL '1 day')
      GROUP BY 1
      ORDER BY 1 ASC
      `,
      params
    );

    res.json({
      ok: true,
      range: { from, to },
      metric,
      ping_seconds: pingSeconds,
      series: r.rows,
    });
  } catch (err) {
    console.error("GET /api/admin/analytics/timeseries error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.get("/top-videos", requireAuth, requireAdmin, async (req, res) => {
  try {
    const from = parseDateParam(req.query.from, 29);
    const to = parseDateParam(req.query.to, 0);
    const by = String(req.query.by || "plays");
    const limit = Math.max(5, Math.min(50, Number(req.query.limit || 10)));
    const pingSeconds = pingSecondsFromReq(req);

    const orderExpr = by === "watch_time" ? `watch_seconds DESC` : `plays DESC`;

    const r = await db.query(
      `
      WITH stats AS (
        SELECT
          video_id,
          COUNT(*) FILTER (WHERE event_type='video_play')::int AS plays,
          COUNT(DISTINCT user_id)::int AS unique_viewers,
          (COUNT(*) FILTER (WHERE event_type='video_progress')::bigint * $3::bigint) AS watch_seconds,
          COUNT(*) FILTER (WHERE event_type='video_complete')::int AS completions
        FROM analytics_events
        WHERE created_at >= ($1::date)
          AND created_at <  (($2::date) + INTERVAL '1 day')
        GROUP BY video_id
      )
      SELECT
        s.*,
        v.title,
        v.thumbnail_url
      FROM stats s
      LEFT JOIN videos v ON v.id = s.video_id
      ORDER BY ${orderExpr}
      LIMIT $4
      `,
      [from, to, pingSeconds, limit]
    );

    res.json({
      ok: true,
      range: { from, to },
      by,
      ping_seconds: pingSeconds,
      items: r.rows,
    });
  } catch (err) {
    console.error("GET /api/admin/analytics/top-videos error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
