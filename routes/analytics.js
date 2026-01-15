// server-api/routes/analytics.js
const router = require("express").Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth"); // matches your auth.js exports

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const xi = Math.floor(x);
  return Math.max(min, Math.min(max, xi));
}

// ---- schema cache ----
let __analyticsSchema = null;

async function getAnalyticsSchema() {
  if (__analyticsSchema) return __analyticsSchema;

  const r = await db.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'analytics_events'
  `
  );

  const cols = new Set((r.rows || []).map((x) => x.column_name));

  // event type column
  const typeCol = cols.has("event_type")
    ? "event_type"
    : cols.has("type")
    ? "type"
    : null;

  // time column
  const timeCol = cols.has("created_at")
    ? "created_at"
    : cols.has("occurred_at")
    ? "occurred_at"
    : null;

  // user identity column (IMPORTANT: don't assume user_id exists)
  const userCol = cols.has("user_id")
    ? "user_id"
    : cols.has("member_id")
    ? "member_id"
    : cols.has("account_id")
    ? "account_id"
    : null;

  // video column (some schemas use different names)
  const videoCol = cols.has("video_id")
    ? "video_id"
    : cols.has("vod_id")
    ? "vod_id"
    : null;

  // position/duration
  const positionCol = cols.has("position_sec")
    ? "position_sec"
    : cols.has("position_seconds")
    ? "position_seconds"
    : null;

  const durationCol = cols.has("duration_sec")
    ? "duration_sec"
    : cols.has("duration_seconds")
    ? "duration_seconds"
    : null;

  const hasPage = cols.has("page");
  const hasMeta = cols.has("meta");
  const anonCol = cols.has("anon_id") ? "anon_id" : null;

  __analyticsSchema = {
    cols,
    typeCol,
    timeCol,
    userCol,
    videoCol,
    positionCol,
    durationCol,
    hasPage,
    hasMeta,
    anonCol,
  };

  return __analyticsSchema;
}

// quick dev helper
router.post("/_refresh-schema", requireAuth, async (_req, res) => {
  __analyticsSchema = null;
  await getAnalyticsSchema();
  res.json({ ok: true });
});

// ---------- POST /api/analytics/event ----------
router.post("/event", requireAuth, async (req, res) => {
  try {
    const s = await getAnalyticsSchema();

    if (!s.typeCol) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing event_type/type column",
      });
    }
    if (!s.timeCol) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing created_at/occurred_at column",
      });
    }

    // auth objects may differ (req.user, req.admin, etc.)
    const actor = req.user || req.admin || null;
    const actorId = actor?.id ?? actor?.user_id ?? actor?.member_id ?? null;

    if (!actorId && !s.anonCol) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const {
      event_type,
      video_id,
      position_seconds,
      duration_seconds,
      meta,
      page,
      anon_id,
    } = req.body || {};

    // Accept these; anything else falls back to *_progress
    const allowed = new Set([
      // VOD
      "video_play",
      "video_progress",
      "video_complete",
      // LIVE
      "live_open",
      "live_progress",
      "live_leave",
    ]);
    const et = allowed.has(event_type) ? event_type : "video_progress";

    const pos = clampInt(position_seconds, 0, 24 * 60 * 60);
    const dur = clampInt(duration_seconds, 0, 24 * 60 * 60);

    // Build insert dynamically ONLY for existing columns
    const cols = [];
    const vals = [];
    const params = [];

    // user identity
    if (s.userCol && actorId != null) {
      cols.push(s.userCol);
      vals.push(`$${(params.push(actorId), params.length)}`);
    } else if (s.anonCol) {
      // fall back to anon_id if available
      cols.push(s.anonCol);
      vals.push(`$${(params.push(anon_id || null), params.length)}`);
    }

    // video id (optional for live)
    if (s.videoCol) {
      const vid =
        video_id == null || video_id === ""
          ? null
          : Number.isFinite(Number(video_id))
          ? Number(video_id)
          : String(video_id);

      cols.push(s.videoCol);
      vals.push(`$${(params.push(vid), params.length)}`);
    }

    // event type
    cols.push(s.typeCol);
    vals.push(`$${(params.push(et), params.length)}`);

    // position/duration
    if (s.positionCol) {
      cols.push(s.positionCol);
      vals.push(`$${(params.push(pos), params.length)}`);
    }
    if (s.durationCol) {
      cols.push(s.durationCol);
      vals.push(`$${(params.push(dur), params.length)}`);
    }

    // page/meta
    if (s.hasPage) {
      cols.push("page");
      vals.push(`$${(params.push(page || null), params.length)}`);
    }
    if (s.hasMeta) {
      cols.push("meta");
      vals.push(
        `$${
          (params.push(meta && typeof meta === "object" ? meta : {}),
          params.length)
        }`
      );
    }

    // time
    cols.push(s.timeCol);
    vals.push("NOW()");

    await db.query(
      `INSERT INTO analytics_events (${cols.join(", ")})
       VALUES (${vals.join(", ")})`,
      params
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/analytics/event error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- GET /api/analytics/summary?days=30&ping_seconds=15 ----------
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pingSeconds = Math.max(
      5,
      Math.min(60, Number(req.query.ping_seconds || 15))
    );

    const s = await getAnalyticsSchema();

    if (!s.typeCol) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing event_type/type column",
      });
    }
    if (!s.timeCol) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing created_at/occurred_at column",
      });
    }

    const typeCol = s.typeCol;
    const timeCol = s.timeCol;
    const userCol = s.userCol; // may be null
    const videoCol = s.videoCol; // may be null

    // If we don't have a user column, unique_viewers becomes 0
    const uniqueExpr = userCol
      ? `COUNT(DISTINCT ${userCol})::bigint`
      : `0::bigint`;

    // Build top videos CTE only if videoCol exists
    const topVideosCTE = videoCol
      ? `
      , top_videos AS (
        SELECT
          b.${videoCol} AS video_id,
          COUNT(*) FILTER (WHERE b.${typeCol}='video_play')::bigint AS plays,
          ${
            userCol ? `COUNT(DISTINCT b.${userCol})::bigint` : `0::bigint`
          } AS unique_viewers,
          (COUNT(*) FILTER (WHERE b.${typeCol}='video_progress')::bigint * $2::bigint) AS watch_seconds
        FROM base b
        WHERE b.${videoCol} IS NOT NULL
        GROUP BY b.${videoCol}
        ORDER BY watch_seconds DESC, plays DESC
        LIMIT 10
      ),
      top_with_video AS (
        SELECT
          t.*,
          v.title,
          COALESCE(
            (to_jsonb(v)->>'thumbnail_url'),
            (to_jsonb(v)->>'thumbnail'),
            (to_jsonb(v)->>'thumb_url'),
            (to_jsonb(v)->>'thumb'),
            (to_jsonb(v)->>'poster_url'),
            (to_jsonb(v)->>'poster'),
            (to_jsonb(v)->>'image_url'),
            (to_jsonb(v)->>'image')
          ) AS thumbnail_url
        FROM top_videos t
        LEFT JOIN videos v ON v.id = t.video_id
      )
      `
      : "";

    const topVideosSelect = videoCol
      ? `(SELECT json_agg(top_with_video) FROM top_with_video) AS top_videos`
      : `('[]'::json) AS top_videos`;

    const r = await db.query(
      `
      WITH base AS (
        SELECT *
        FROM analytics_events
        WHERE ${timeCol} >= NOW() - ($1::int * INTERVAL '1 day')
      ),
      counts AS (
        SELECT ${typeCol} AS type, COUNT(*)::bigint AS n
        FROM base
        GROUP BY ${typeCol}
        ORDER BY n DESC
      ),
      totals AS (
        SELECT
          COUNT(*) FILTER (WHERE ${typeCol}='video_play')::bigint AS plays,
          ${uniqueExpr} AS unique_viewers,
          COUNT(*) FILTER (WHERE ${typeCol}='video_progress')::bigint AS progress_events,
          COUNT(*) FILTER (WHERE ${typeCol}='video_complete')::bigint AS completions
        FROM base
      )
      ${topVideosCTE}
      SELECT
        (SELECT json_agg(counts) FROM counts) AS counts,
        (SELECT row_to_json(totals) FROM totals) AS totals,
        ${topVideosSelect}
      `,
      [days, pingSeconds]
    );

    const row = r.rows[0] || {};
    const totals = row.totals || {
      plays: 0,
      unique_viewers: 0,
      progress_events: 0,
      completions: 0,
    };

    const watchSeconds = Number(totals.progress_events || 0) * pingSeconds;

    res.json({
      ok: true,
      days,
      ping_seconds: pingSeconds,
      watch_seconds: watchSeconds,
      watch_hours: watchSeconds / 3600,
      totals: {
        plays: Number(totals.plays || 0),
        unique_viewers: Number(totals.unique_viewers || 0),
        completions: Number(totals.completions || 0),
        completion_rate:
          Number(totals.plays || 0) > 0
            ? Math.round(
                (Number(totals.completions || 0) / Number(totals.plays || 0)) *
                  100
              )
            : 0,
        avg_watch_seconds_per_play:
          Number(totals.plays || 0) > 0
            ? Math.round(watchSeconds / Number(totals.plays || 0))
            : 0,
      },
      counts: row.counts || [],
      top_videos: row.top_videos || [],
      schema: {
        type_col: s.typeCol,
        time_col: s.timeCol,
        user_col: s.userCol,
        video_col: s.videoCol,
        position_col: s.positionCol,
        duration_col: s.durationCol,
      },
    });
  } catch (err) {
    console.error("GET /api/analytics/summary error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ---------- GET /api/analytics/live?minutes=10 ----------
router.get("/live", requireAuth, async (req, res) => {
  try {
    const minutes = Math.max(1, Math.min(180, Number(req.query.minutes || 10)));
    const s = await getAnalyticsSchema();

    if (!s.typeCol || !s.timeCol) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing required columns",
      });
    }

    const typeCol = s.typeCol;
    const timeCol = s.timeCol;

    const r = await db.query(
      `
      WITH base AS (
        SELECT *
        FROM analytics_events
        WHERE ${timeCol} >= NOW() - ($1::int * INTERVAL '1 minute')
          AND ${typeCol} IN ('live_open','live_progress','live_leave')
      )
      SELECT
        COUNT(*) FILTER (WHERE ${typeCol}='live_open')::bigint AS live_open,
        COUNT(*) FILTER (WHERE ${typeCol}='live_progress')::bigint AS live_progress,
        COUNT(*) FILTER (WHERE ${typeCol}='live_leave')::bigint AS live_leave
      FROM base
      `,
      [minutes]
    );

    const row = r.rows[0] || {};
    res.json({
      ok: true,
      minutes,
      live_open: Number(row.live_open || 0),
      live_progress: Number(row.live_progress || 0),
      live_leave: Number(row.live_leave || 0),
    });
  } catch (err) {
    console.error("GET /api/analytics/live error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
