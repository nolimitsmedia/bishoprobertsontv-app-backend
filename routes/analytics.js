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
    WHERE table_schema='public'
      AND table_name='analytics_events'
  `
  );

  const cols = new Set((r.rows || []).map((x) => x.column_name));
  const has = (c) => cols.has(c);

  const schema = {
    cols,

    // type columns (some schemas have one or both)
    hasType: has("type"),
    hasEventType: has("event_type"),

    // time columns
    hasCreatedAt: has("created_at"),
    hasOccurredAt: has("occurred_at"),

    // user identity columns
    hasUserId: has("user_id"),
    hasMemberId: has("member_id"),
    hasAccountId: has("account_id"),

    // anon
    hasAnonId: has("anon_id"),

    // video id columns
    hasVideoId: has("video_id"),
    hasVodId: has("vod_id"),

    // position/duration columns
    posCol: has("position_sec")
      ? "position_sec"
      : has("position_seconds")
      ? "position_seconds"
      : null,
    durCol: has("duration_sec")
      ? "duration_sec"
      : has("duration_seconds")
      ? "duration_seconds"
      : null,

    hasPage: has("page"),
    hasMeta: has("meta"),
  };

  schema.typeExpr =
    schema.hasType && schema.hasEventType
      ? "COALESCE(type, event_type)"
      : schema.hasType
      ? "type"
      : schema.hasEventType
      ? "event_type"
      : null;

  schema.timeExpr =
    schema.hasCreatedAt && schema.hasOccurredAt
      ? "COALESCE(created_at, occurred_at)"
      : schema.hasCreatedAt
      ? "created_at"
      : schema.hasOccurredAt
      ? "occurred_at"
      : null;

  schema.userExpr =
    schema.hasUserId || schema.hasMemberId || schema.hasAccountId
      ? `COALESCE(${schema.hasUserId ? "user_id" : "NULL"},
               ${schema.hasMemberId ? "member_id" : "NULL"},
               ${schema.hasAccountId ? "account_id" : "NULL"})`
      : null;

  schema.videoExpr =
    schema.hasVideoId && schema.hasVodId
      ? "COALESCE(video_id, vod_id)"
      : schema.hasVideoId
      ? "video_id"
      : schema.hasVodId
      ? "vod_id"
      : null;

  __analyticsSchema = schema;
  return schema;
}

function getActorId(req) {
  const actor = req.user || req.admin || null;
  return (
    actor?.id ?? actor?.user_id ?? actor?.member_id ?? actor?.account_id ?? null
  );
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

    if (!s.typeExpr) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing type/event_type column",
      });
    }
    if (!s.timeExpr) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing created_at/occurred_at column",
      });
    }

    const actorId = getActorId(req);

    if (!actorId && !s.hasAnonId) {
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
    const et = allowed.has(event_type) ? event_type : null;
    if (!et) {
      return res.status(400).json({ ok: false, error: "Invalid event_type" });
    }

    // For video_* events we require a video id (this prevents "Top Videos only shows one item" bugs)
    const isVideoEvent = et.startsWith("video_");
    if (isVideoEvent && (video_id == null || video_id === "")) {
      return res
        .status(400)
        .json({ ok: false, error: "video_id is required for video events" });
    }

    const pos = clampInt(position_seconds, 0, 24 * 60 * 60);
    const dur = clampInt(duration_seconds, 0, 24 * 60 * 60);

    const cols = [];
    const vals = [];
    const params = [];

    // ---- identity ----
    if (actorId != null) {
      if (s.hasUserId) {
        cols.push("user_id");
        vals.push(`$${(params.push(actorId), params.length)}`);
      } else if (s.hasMemberId) {
        cols.push("member_id");
        vals.push(`$${(params.push(actorId), params.length)}`);
      } else if (s.hasAccountId) {
        cols.push("account_id");
        vals.push(`$${(params.push(actorId), params.length)}`);
      } else if (s.hasAnonId) {
        cols.push("anon_id");
        vals.push(`$${(params.push(anon_id || null), params.length)}`);
      }
    } else if (s.hasAnonId) {
      cols.push("anon_id");
      vals.push(`$${(params.push(anon_id || null), params.length)}`);
    }

    // ---- video id ----
    const vid =
      video_id == null || video_id === ""
        ? null
        : Number.isFinite(Number(video_id))
        ? Number(video_id)
        : String(video_id);

    if (s.hasVideoId) {
      cols.push("video_id");
      vals.push(`$${(params.push(vid), params.length)}`);
    } else if (s.hasVodId) {
      cols.push("vod_id");
      vals.push(`$${(params.push(vid), params.length)}`);
    }

    // ---- write BOTH type columns when both exist ----
    if (s.hasType) {
      cols.push("type");
      vals.push(`$${(params.push(et), params.length)}`);
    }
    if (s.hasEventType) {
      cols.push("event_type");
      vals.push(`$${(params.push(et), params.length)}`);
    }

    // position/duration
    if (s.posCol) {
      cols.push(s.posCol);
      vals.push(`$${(params.push(pos), params.length)}`);
    }
    if (s.durCol) {
      cols.push(s.durCol);
      vals.push(`$${(params.push(dur), params.length)}`);
    }

    // page/meta
    if (s.hasPage) {
      cols.push("page");
      vals.push(`$${(params.push(page || null), params.length)}`);
    }
    if (s.hasMeta) {
      cols.push("meta");
      // ensure jsonb/json storage works reliably
      const cleanMeta = meta && typeof meta === "object" ? meta : {};
      vals.push(`$${(params.push(cleanMeta), params.length)}::jsonb`);
    }

    // ---- write BOTH time columns when both exist ----
    if (s.hasCreatedAt) {
      cols.push("created_at");
      vals.push("NOW()");
    }
    if (s.hasOccurredAt) {
      cols.push("occurred_at");
      vals.push("NOW()");
    }

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

// ---------- GET /api/analytics/summary?days=30&ping_seconds=15&dedupe_plays=1 ----------
router.get("/summary", requireAuth, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, Number(req.query.days || 30)));
    const pingSeconds = Math.max(
      5,
      Math.min(60, Number(req.query.ping_seconds || 15))
    );

    // default: dedupe plays (same user + same video + same day counts as 1 play)
    const dedupePlays = String(req.query.dedupe_plays ?? "1") !== "0";

    const s = await getAnalyticsSchema();

    if (!s.typeExpr) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing type/event_type column",
      });
    }
    if (!s.timeExpr) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing created_at/occurred_at column",
      });
    }

    const typeExpr = s.typeExpr;
    const timeExpr = s.timeExpr;

    const uniqueExpr = s.userExpr
      ? `COUNT(DISTINCT ${s.userExpr})::bigint`
      : `0::bigint`;

    const hasDuration = !!s.durCol;

    // ✅ Prefer meta.delta_seconds when available; fallback to pingSeconds
    const metaDeltaExpr = s.hasMeta
      ? `NULLIF((meta->>'delta_seconds')::int, 0)`
      : `NULL`;

    // plays expression: dedupe if we can identify user + video
    const playsExpr =
      dedupePlays && s.userExpr && s.videoExpr
        ? `COUNT(DISTINCT (${s.userExpr}, ${s.videoExpr}, date_trunc('day', ${timeExpr}))) FILTER (WHERE ${typeExpr}='video_play')::bigint`
        : `COUNT(*) FILTER (WHERE ${typeExpr}='video_play')::bigint`;

    const topPlaysExpr =
      dedupePlays && s.userExpr && s.videoExpr
        ? `COUNT(DISTINCT (${s.userExpr}, ${s.videoExpr}, date_trunc('day', ${timeExpr}))) FILTER (WHERE ${typeExpr}='video_play')::bigint`
        : `COUNT(*) FILTER (WHERE ${typeExpr}='video_play')::bigint`;

    const topVideosCTE = s.videoExpr
      ? `
      , top_videos AS (
        SELECT
          ${s.videoExpr} AS video_id,
          ${topPlaysExpr} AS plays,
          ${
            s.userExpr ? `COUNT(DISTINCT ${s.userExpr})::bigint` : `0::bigint`
          } AS unique_viewers,

          -- watch time: sum delta_seconds if present; else assume pingSeconds per progress
          SUM(
            CASE
              WHEN ${typeExpr}='video_progress'
                THEN COALESCE(${metaDeltaExpr}, $2::int)
              ELSE 0
            END
          )::bigint AS watch_seconds,

          ${
            hasDuration
              ? `SUM(${s.durCol}) FILTER (WHERE ${typeExpr}='video_complete')::bigint AS complete_duration_seconds`
              : `0::bigint AS complete_duration_seconds`
          }
        FROM base b
        WHERE ${s.videoExpr} IS NOT NULL
        GROUP BY ${s.videoExpr}
        ORDER BY watch_seconds DESC, plays DESC
        LIMIT 10
      ),
      top_with_video AS (
        SELECT
          t.video_id,
          t.plays,
          t.unique_viewers,
          CASE
            WHEN t.watch_seconds > 0 THEN t.watch_seconds
            ELSE COALESCE(t.complete_duration_seconds,0)
          END AS watch_seconds,
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

    const topVideosSelect = s.videoExpr
      ? `(SELECT COALESCE(json_agg(top_with_video), '[]'::json) FROM top_with_video) AS top_videos`
      : `('[]'::json) AS top_videos`;

    const r = await db.query(
      `
      WITH base AS (
        SELECT *
        FROM analytics_events
        WHERE ${timeExpr} >= NOW() - ($1::int * INTERVAL '1 day')
      ),
      counts AS (
        SELECT ${typeExpr} AS type, COUNT(*)::bigint AS n
        FROM base
        GROUP BY ${typeExpr}
        ORDER BY n DESC
      ),
      totals AS (
        SELECT
          ${playsExpr} AS plays,
          ${uniqueExpr} AS unique_viewers,
          COUNT(*) FILTER (WHERE ${typeExpr}='video_progress')::bigint AS progress_events,

          SUM(
            CASE
              WHEN ${typeExpr}='video_progress'
                THEN COALESCE(${metaDeltaExpr}, $2::int)
              ELSE 0
            END
          )::bigint AS watch_seconds_from_progress,

          COUNT(*) FILTER (WHERE ${typeExpr}='video_complete')::bigint AS completions
          ${
            hasDuration
              ? `, SUM(${s.durCol}) FILTER (WHERE ${typeExpr}='video_complete')::bigint AS complete_duration_seconds`
              : `, 0::bigint AS complete_duration_seconds`
          }
        FROM base
      )
      ${topVideosCTE}
      SELECT
        (SELECT COALESCE(json_agg(counts), '[]'::json) FROM counts) AS counts,
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
      watch_seconds_from_progress: 0,
      completions: 0,
      complete_duration_seconds: 0,
    };

    const watchSecondsFromProgress = Number(
      totals.watch_seconds_from_progress || 0
    );

    const completeDurationSeconds = Number(
      totals.complete_duration_seconds || 0
    );

    const watchSeconds =
      watchSecondsFromProgress > 0
        ? watchSecondsFromProgress
        : completeDurationSeconds;

    res.json({
      ok: true,
      days,
      ping_seconds: pingSeconds,
      dedupe_plays: dedupePlays,
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
      top_videos: (row.top_videos || []).map((x) => ({
        ...x,
        watch_seconds: Number(x.watch_seconds || 0),
      })),
      schema: {
        has_type: s.hasType,
        has_event_type: s.hasEventType,
        has_created_at: s.hasCreatedAt,
        has_occurred_at: s.hasOccurredAt,
        user_expr: s.userExpr,
        video_expr: s.videoExpr,
        type_expr: s.typeExpr,
        time_expr: s.timeExpr,
        pos_col: s.posCol,
        dur_col: s.durCol,
        has_meta: s.hasMeta,
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

    if (!s.typeExpr || !s.timeExpr) {
      return res.status(500).json({
        ok: false,
        error: "analytics_events missing required columns",
      });
    }

    const typeExpr = s.typeExpr;
    const timeExpr = s.timeExpr;

    const r = await db.query(
      `
      WITH base AS (
        SELECT *
        FROM analytics_events
        WHERE ${timeExpr} >= NOW() - ($1::int * INTERVAL '1 minute')
          AND ${typeExpr} IN ('live_open','live_progress','live_leave')
      )
      SELECT
        COUNT(*) FILTER (WHERE ${typeExpr}='live_open')::bigint AS live_open,
        COUNT(*) FILTER (WHERE ${typeExpr}='live_progress')::bigint AS live_progress,
        COUNT(*) FILTER (WHERE ${typeExpr}='live_leave')::bigint AS live_leave
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
