// server-api/routes/live.js
const express = require("express");
const router = express.Router();
const axios = require("axios");
const db = require("../db");

// Auth middlewares
const authenticate = require("../middleware/authenticate"); // if you use this elsewhere
const { requireAuth /*, requireAdmin*/ } = require("../middleware/auth");

// Entitlements / usage
const {
  attachEntitlements /*, checkQuota */,
} = require("../middleware/entitlements");
const { addUsage, getMonthlyUsage } = require("../services/usage");

/* -----------------------------------------
   Config
----------------------------------------- */
const LIVEPEER_BASE =
  process.env.LIVEPEER_BASE || "https://livepeer.studio/api";
const LIVEPEER_API_KEY = process.env.LIVEPEER_API_KEY || "";

const RTMP_INGEST =
  process.env.LIVEPEER_RTMP_INGEST || "rtmp://rtmp.livepeer.studio/live";
const HLS_CDN_BASE =
  process.env.LIVEPEER_HLS_CDN_BASE || "https://livepeercdn.com/hls";

/* -----------------------------------------
   Helpers (Livepeer requests)
----------------------------------------- */
async function lpGet(path) {
  const { data } = await axios.get(`${LIVEPEER_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${LIVEPEER_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return data;
}
async function lpPost(path, body) {
  const { data } = await axios.post(`${LIVEPEER_BASE}${path}`, body, {
    headers: {
      Authorization: `Bearer ${LIVEPEER_API_KEY}`,
      "Content-Type": "application/json",
    },
  });
  return data;
}

/* -----------------------------------------
   Create live event (+ Livepeer stream)
   body: { title, description, visibility, is_premium, record, start_at }
----------------------------------------- */
router.post("/events", authenticate, async (req, res) => {
  try {
    const {
      title = `Event ${Date.now()}`,
      description = "",
      visibility = "unlisted",
      is_premium = false,
      record = true,
      start_at = null,
    } = req.body || {};

    // 1) Create Livepeer stream
    const lp = await lpPost("/stream", { name: title, record: !!record });

    const provider_stream_id = lp?.id || lp?.data?.id || null;
    const stream_key = lp?.streamKey || lp?.data?.streamKey || null;
    const playback_id = lp?.playbackId || lp?.data?.playbackId || null;

    // Compute HLS playback url for convenience
    const hls_url = playback_id
      ? `${HLS_CDN_BASE}/${playback_id}/index.m3u8`
      : null;

    // 2) Persist event
    const ins = await db.query(
      `INSERT INTO live_events
       (title, description, status, visibility, is_premium, start_at,
        provider, provider_stream_id, stream_key, playback_id,
        rtmp_ingest, hls_url, record, created_by, created_at)
       VALUES ($1,$2,'scheduled',$3,$4,$5,'livepeer',$6,$7,$8,$9,$10,$11,$12,now())
       RETURNING *`,
      [
        title,
        description,
        visibility,
        is_premium,
        start_at,
        provider_stream_id,
        stream_key,
        playback_id,
        RTMP_INGEST, // ensure UI always has an ingest base
        hls_url,
        !!record,
        // support either auth style
        (req.user && req.user.id) || (req.auth && req.auth.id) || null,
      ]
    );

    return res.json(ins.rows[0]);
  } catch (err) {
    console.error("POST /live/events error:", err?.response?.data || err);
    return res.status(500).json({ message: "Failed to create event" });
  }
});

/* -----------------------------------------
   List / Get (with fallbacks for ingest + hls)
----------------------------------------- */
function attachPlaybackFallback(row) {
  if (!row.rtmp_ingest) row.rtmp_ingest = RTMP_INGEST;
  if (!row.hls_url && row.playback_id) {
    row.hls_url = `${HLS_CDN_BASE}/${row.playback_id}/index.m3u8`;
  }
  return row;
}

router.get("/events", authenticate, async (_req, res) => {
  const q = await db.query("SELECT * FROM live_events ORDER BY id DESC");
  res.json({ items: q.rows.map(attachPlaybackFallback) });
});

router.get("/events/:id", async (req, res) => {
  const q = await db.query("SELECT * FROM live_events WHERE id=$1", [
    req.params.id,
  ]);
  if (!q.rows[0]) return res.status(404).json({ message: "Not found" });
  res.json(attachPlaybackFallback(q.rows[0]));
});

/* -----------------------------------------
   Start (optional UI flip)
----------------------------------------- */
router.post("/events/:id/start", authenticate, async (req, res) => {
  const up = await db.query(
    "UPDATE live_events SET status='live', updated_at=now() WHERE id=$1 RETURNING *",
    [req.params.id]
  );
  if (!up.rows[0]) return res.status(404).json({ message: "Not found" });
  res.json(attachPlaybackFallback(up.rows[0]));
});

/* -----------------------------------------
   End: mark ended + try to create VOD
   Attempts to locate the last recorded session -> asset -> playbackId
   Falls back gracefully if not found.
----------------------------------------- */
router.post("/events/:id/end", authenticate, async (req, res) => {
  try {
    // 1) load event
    const q = await db.query("SELECT * FROM live_events WHERE id=$1", [
      req.params.id,
    ]);
    const evt = q.rows[0];
    if (!evt) return res.status(404).json({ message: "Not found" });

    // 2) mark as ended
    await db.query(
      "UPDATE live_events SET status='ended', updated_at=now() WHERE id=$1",
      [evt.id]
    );

    let createdVodId = null;

    if (evt.record && evt.provider === "livepeer" && evt.provider_stream_id) {
      try {
        // Sessions for this stream
        const sessions = await lpGet(
          `/stream/${evt.provider_stream_id}/sessions`
        );

        // Find a recorded session that is ready / has assetId
        let assetId = null;
        if (Array.isArray(sessions) && sessions.length) {
          const rec = sessions
            .slice()
            .reverse()
            .find((s) => s?.recordingStatus === "ready" && s?.assetId);
          if (rec?.assetId) assetId = rec.assetId;
        }

        if (assetId) {
          const asset = await lpGet(`/asset/${assetId}`);
          const vodPlaybackId = asset?.playbackId;

          if (vodPlaybackId) {
            const vodUrl = `${HLS_CDN_BASE}/${vodPlaybackId}/index.m3u8`;
            // Create a videos row (match your schema)
            const title = `Replay: ${evt.title || "Live Event"}`;
            const ins = await db.query(
              `INSERT INTO videos
               (title, description, video_url, thumbnail_url, category_id,
                is_premium, visibility, created_by)
               VALUES ($1,$2,$3,NULL,NULL,$4,$5,$6)
               RETURNING id`,
              [
                title,
                evt.description || "",
                vodUrl,
                !!evt.is_premium,
                evt.visibility || "public",
                evt.created_by || null,
              ]
            );
            createdVodId = ins.rows[0]?.id || null;

            // link to the event
            await db.query(
              "UPDATE live_events SET vod_video_id=$1 WHERE id=$2",
              [createdVodId, evt.id]
            );
          }
        }
      } catch (e) {
        console.warn(
          "end() could not auto-create VOD:",
          e?.response?.data || e
        );
      }
    }

    const out = await db.query("SELECT * FROM live_events WHERE id=$1", [
      evt.id,
    ]);
    const ended = attachPlaybackFallback(out.rows[0]);
    ended.vod_video_id = ended.vod_video_id || createdVodId || null;
    return res.json(ended);
  } catch (err) {
    console.error("POST /live/events/:id/end error:", err);
    return res.status(500).json({ message: "Failed to end event" });
  }
});

/* -----------------------------------------
   Chat history (Socket.IO handles posting)
----------------------------------------- */
router.get("/events/:id/chat", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "200", 10), 500);
  const q = await db.query(
    `SELECT id, event_id, user_id, name, message, created_at
       FROM live_chat_messages
       WHERE event_id=$1
       ORDER BY created_at ASC
       LIMIT $2`,
    [req.params.id, limit]
  );
  res.json({ items: q.rows });
});

/* -----------------------------------------
   Preregistration + ICS download
   GET  /live/events/:id/register?ics=1  -> .ics file
   POST /live/events/:id/register { name, email } -> ok
----------------------------------------- */
router.get("/events/:id/register", async (req, res) => {
  try {
    const { id } = req.params;
    const ev = await db.query("SELECT * FROM live_events WHERE id=$1", [id]);
    const row = ev.rows[0];
    if (!row) return res.status(404).send("Not found");

    // ?ics=1 -> serve calendar invite
    if (String(req.query.ics) === "1") {
      const start =
        row.start_at || new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const dt = (d) =>
        new Date(d)
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d{3}Z$/, "Z");

      const dtStart = dt(start);
      const dtEnd = dt(new Date(new Date(start).getTime() + 60 * 60 * 1000));
      const ics = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//BishopTV//Live//EN",
        "BEGIN:VEVENT",
        `UID:live-${row.id}@bishop.tv`,
        `DTSTAMP:${dt(new Date())}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${(row.title || "Live event").replace(/\n/g, " ")}`,
        `DESCRIPTION:${(row.description || "").replace(/\n/g, " ")}`,
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\r\n");

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="event-${row.id}.ics"`
      );
      return res.send(ics);
    }

    // Otherwise a simple OK (or render an HTML prereg form if preferred)
    return res.json({ ok: true });
  } catch (e) {
    console.error("GET /live/events/:id/register error:", e);
    return res.status(500).json({ message: "Failed" });
  }
});

router.post("/events/:id/register", async (_req, res) => {
  // If needed, store preregistration in a table (e.g., live_prereg)
  return res.json({ ok: true });
});

/* -----------------------------------------
   Consume monthly live-hours (generic)
   POST /live/end { started_at, ended_at? }
----------------------------------------- */
router.post("/end", requireAuth, attachEntitlements, async (req, res) => {
  try {
    const startedAt = new Date(req.body.started_at);
    const endedAt = new Date(req.body.ended_at || Date.now());
    if (!startedAt || isNaN(+startedAt)) {
      return res.status(400).json({ error: "Invalid or missing started_at" });
    }
    const hours = Math.max(0, (endedAt - startedAt) / 36e5);

    const limit = req.entitlements?.quotas?.live_hours_monthly;
    if (limit != null) {
      const used = await getMonthlyUsage(req.user.id, "live_hours_monthly");
      if (used + hours > limit + 1e-9) {
        return res.status(402).json({
          error: "Monthly live hours exceeded",
          used,
          attempt: hours,
          limit,
        });
      }
    }

    await addUsage(req.user.id, "live_hours_monthly", hours, {
      reason: "live_session",
    });
    res.json({ ok: true, consumed_hours: Number(hours.toFixed(3)) });
  } catch (e) {
    console.error("live/end error:", e);
    res.status(500).json({ error: "Live end failed" });
  }
});

module.exports = router;
