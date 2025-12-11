// server-api/routes/streamcontrol.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

/* ------------------------------------------------------------------
   ENV
-------------------------------------------------------------------*/
const {
  STREAMCONTROL_API_TOKEN,
  STREAMCONTROL_API_BASE,
  STREAMCONTROL_CHANNEL_ID,
  STREAMCONTROL_RTMP_URL,
  STREAMCONTROL_STREAM_KEY,
  STREAMCONTROL_HLS_URL,
  STREAMCONTROL_PUBLIC_URL,
} = process.env;

const API_BASE = (
  STREAMCONTROL_API_BASE || "https://api.streamcontrol.live/v1"
).replace(/\/+$/, "");

const HAS_TOKEN = !!STREAMCONTROL_API_TOKEN;

/* ------------------------------------------------------------------
   Axios Client
-------------------------------------------------------------------*/
const sc = axios.create({
  baseURL: API_BASE,
  timeout: 15000,
  headers: HAS_TOKEN
    ? { Authorization: `Bearer ${STREAMCONTROL_API_TOKEN}` }
    : undefined,
});

async function scRequest(method, path, data) {
  if (!HAS_TOKEN) {
    const err = new Error("NO_TOKEN");
    err.code = "NO_TOKEN";
    throw err;
  }
  const res = await sc.request({ method, url: path, data });
  return res.data;
}

/* ------------------------------------------------------------------
   Channel Normalization
-------------------------------------------------------------------*/
function normalizeChannel(payload = {}) {
  const id =
    payload.id ||
    payload.channelId ||
    payload.handle ||
    STREAMCONTROL_CHANNEL_ID ||
    "demo";

  const name = payload.name || payload.title || "NLM TEST";
  const handle = payload.handle || id;

  const ingest_url =
    payload.ingest_url ||
    payload.rtmpUrl ||
    STREAMCONTROL_RTMP_URL ||
    "rtmps://ingest.mycloudstream.io:1936/static";

  const stream_key =
    payload.stream_key || payload.streamKey || STREAMCONTROL_STREAM_KEY || "";

  const hls_url =
    payload.hls_url ||
    STREAMCONTROL_HLS_URL ||
    `https://cdn.mycloudstream.io/hls/live/broadcast/${handle}/index.m3u8`;

  const public_url =
    payload.public_url ||
    STREAMCONTROL_PUBLIC_URL ||
    `https://my.streamcontrol.live/public/${handle}`;

  // metrics object from StreamControl (shape can evolve)
  const metrics = payload.metrics || {};

  // online state
  const online =
    payload.online ?? payload.is_online ?? payload.status === "online" ?? false;

  const status_text = payload.status_text || (online ? "Online" : "Ready");

  // live metrics
  const viewers_live =
    metrics.current_viewers ?? metrics.viewers_live ?? metrics.viewers ?? 0;

  // bitrate: support mbps or kbps
  let bitrate_mbps = 0;
  if (typeof metrics.bitrate_mbps === "number") {
    bitrate_mbps = metrics.bitrate_mbps;
  } else if (typeof metrics.bitrate_kbps === "number") {
    bitrate_mbps = metrics.bitrate_kbps / 1000;
  }

  // how long stream has been running (seconds)
  const starting_for_sec = Number(
    metrics.uptime_sec ||
      metrics.broadcast_time_sec ||
      metrics.live_seconds ||
      0
  );

  // quality / profile label if StreamControl exposes one
  const quality =
    payload.profile ||
    payload.live_profile ||
    payload.output_profile ||
    metrics.profile ||
    "";

  const recording = !!(
    payload.recording ||
    payload.is_recording ||
    metrics.recording_active
  );

  return {
    id,
    name,
    handle,

    ingest_url,
    ingestUrl: ingest_url,
    stream_key,
    streamKey: stream_key,

    hls_url,
    hlsUrl: hls_url,
    public_url,
    publicUrl: public_url,

    player_iframe_src: `https://my.streamcontrol.live/player/${handle}?autoplay=true`,

    online,
    status_text,

    viewers_live,
    bitrate_mbps,
    starting_for_sec,
    quality,
    recording,
  };
}

function fallbackChannel(id = STREAMCONTROL_CHANNEL_ID || "demo") {
  return normalizeChannel({
    id,
    name: "NLM TEST",
    ingest_url: STREAMCONTROL_RTMP_URL,
    stream_key: STREAMCONTROL_STREAM_KEY,
    hls_url: STREAMCONTROL_HLS_URL,
    public_url: STREAMCONTROL_PUBLIC_URL,
    online: false,
    recording: false,
  });
}

/* ------------------------------------------------------------------
   CHANNEL LIST + DETAILS
-------------------------------------------------------------------*/
router.get("/channels", async (_req, res) => {
  try {
    const data = await scRequest("get", "/channels");
    const items = Array.isArray(data) ? data : data?.items || [];
    if (!items.length) return res.json([fallbackChannel()]);
    return res.json(items.map(normalizeChannel));
  } catch {
    return res.json([fallbackChannel()]);
  }
});

router.get("/channels/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${id}`);
    return res.json(normalizeChannel(data));
  } catch {
    return res.json(fallbackChannel(id));
  }
});

/* ==================================================================
   IMPORTANT: NEXT-LIVE ROUTES MUST BE ABOVE ALL "/:id/..." ROUTES
===================================================================*/

// GET next live datetime
router.get("/:channel_id/next-live", async (req, res) => {
  try {
    const { channel_id } = req.params;

    const row = await req.db.query(
      "SELECT next_live_datetime FROM live_schedules WHERE channel_id = $1 LIMIT 1",
      [channel_id]
    );

    return res.json({
      ok: true,
      next_live_datetime:
        row.rows[0]?.next_live_datetime?.toISOString() || null,
    });
  } catch (_err) {
    return res.status(500).json({ ok: false });
  }
});

// SAVE next live datetime
router.post("/:channel_id/next-live", async (req, res) => {
  try {
    const { channel_id } = req.params;
    const { next_live_datetime } = req.body;

    await req.db.query(
      `INSERT INTO live_schedules (channel_id, next_live_datetime)
       VALUES ($1, $2)
       ON CONFLICT (channel_id)
       DO UPDATE SET next_live_datetime = EXCLUDED.next_live_datetime`,
      [channel_id, next_live_datetime]
    );

    return res.json({ ok: true });
  } catch (_err) {
    return res.status(500).json({ ok: false });
  }
});

/* ------------------------------------------------------------------
   STATS
-------------------------------------------------------------------*/
router.get("/:channelId/stats", async (req, res) => {
  const { channelId } = req.params;

  try {
    const data = await scRequest("get", `/channels/${channelId}`);
    const ch = normalizeChannel(data);

    return res.json({
      status: ch.online ? "online" : "ready",
      online: ch.online,
      starting_for_sec: ch.starting_for_sec || 0,
      viewers: ch.viewers_live || 0,
      bitrate_mbps: ch.bitrate_mbps || 0,
      recording: ch.recording || false,
      quality: ch.quality || "",
    });
  } catch {
    return res.json({
      status: "ready",
      online: false,
      starting_for_sec: 0,
      viewers: 0,
      bitrate_mbps: 0,
      recording: false,
      quality: "",
    });
  }
});

/* ------------------------------------------------------------------
   RECORDING TOGGLE
-------------------------------------------------------------------*/
// NOTE: adjust the internal StreamControl path according to their API docs.
router.post("/:channelId/recording-toggle", async (req, res) => {
  const { channelId } = req.params;

  try {
    // Example: POST /channels/:id/recording-toggle on StreamControl
    const data = await scRequest(
      "post",
      `/channels/${channelId}/recording-toggle`
    );

    // Some APIs return { channel: {...} }, others just the channel
    const channelPayload = data.channel || data;
    const ch = normalizeChannel(channelPayload);

    return res.json({ ok: true, recording: ch.recording });
  } catch (err) {
    console.error("recording-toggle error", err?.response?.data || err.message);
    return res
      .status(500)
      .json({ ok: false, error: "RECORDING_TOGGLE_FAILED" });
  }
});

/* ------------------------------------------------------------------
   ENCODER INFO
-------------------------------------------------------------------*/
router.get("/:id/encoder", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${id}`);
    const ch = normalizeChannel(data);
    res.json({
      rtmp_url: ch.ingest_url,
      stream_key: ch.stream_key,
      streamKey: ch.streamKey,
    });
  } catch {
    const ch = fallbackChannel(id);
    res.json({
      rtmp_url: ch.ingest_url,
      stream_key: ch.stream_key,
      streamKey: ch.streamKey,
    });
  }
});

/* ------------------------------------------------------------------
   PLAYER
-------------------------------------------------------------------*/
router.get("/:id/player", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${id}`);
    const ch = normalizeChannel(data);
    res.json({
      iframe: `<iframe src="${ch.player_iframe_src}" width="100%" height="100%" frameborder="0" allow="autoplay" allowfullscreen></iframe>`,
      hls_url: ch.hls_url,
      public_url: ch.public_url,
    });
  } catch {
    const ch = fallbackChannel(id);
    res.json({
      iframe: `<iframe src="${ch.player_iframe_src}" width="100%" height="100%" frameborder="0" allow="autoplay" allowfullscreen></iframe>`,
      hls_url: ch.hls_url,
      public_url: ch.public_url,
    });
  }
});

/* ------------------------------------------------------------------
   EVENTS
-------------------------------------------------------------------*/
router.get("/:id/events", async (_req, res) => {
  return res.json([]);
});

/* ------------------------------------------------------------------
   LEGACY EVENTS ROUTE
-------------------------------------------------------------------*/
router.get("/events", async (_req, res) => {
  res.json({ upcoming: [], past: [] });
});

module.exports = router;
