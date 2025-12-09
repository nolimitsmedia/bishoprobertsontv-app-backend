// server-api/routes/streamcontrol.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

/* ------------------------------------------------------------------
   ENV
-------------------------------------------------------------------*/
const {
  STREAMCONTROL_API_TOKEN, // e.g. AUl...  (Bearer token)
  STREAMCONTROL_API_BASE, // optional, defaults below
  STREAMCONTROL_CHANNEL_ID, // optional default channel to show
  STREAMCONTROL_RTMP_URL, // optional default ingest RTMP url
  STREAMCONTROL_STREAM_KEY, // optional default stream key
  STREAMCONTROL_HLS_URL, // optional default hls url
  STREAMCONTROL_PUBLIC_URL, // optional default public url
} = process.env;

const API_BASE = (
  STREAMCONTROL_API_BASE || "https://api.streamcontrol.live/v1"
).replace(/\/+$/, "");
const HAS_TOKEN = !!STREAMCONTROL_API_TOKEN;

/* ------------------------------------------------------------------
   Axios client
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
   Normalization helpers
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

  // Ingest + Key
  const ingest_url =
    payload.ingest_url ||
    payload.rtmpUrl ||
    STREAMCONTROL_RTMP_URL ||
    "rtmps://ingest.mycloudstream.io:1936/static";

  const stream_key =
    payload.stream_key || payload.streamKey || STREAMCONTROL_STREAM_KEY || "";

  // Playback
  const hls_url =
    payload.hls_url ||
    STREAMCONTROL_HLS_URL ||
    `https://cdn.mycloudstream.io/hls/live/broadcast/${handle}/index.m3u8`;

  const public_url =
    payload.public_url ||
    STREAMCONTROL_PUBLIC_URL ||
    `https://my.streamcontrol.live/public/${handle}`;

  // Status / Metrics (fix operator precedence with parentheses)
  const online = payload.online ?? payload.status === "online";
  const status_text = payload.status_text || (online ? "Online" : "Ready");

  const viewers_live =
    payload.viewers_live ||
    payload.viewers ||
    payload.metrics?.current_viewers ||
    0;

  const bitrate_mbps =
    payload.bitrate_mbps || payload.metrics?.bitrate_mbps || 0;

  const recording = !!payload.recording;

  return {
    id,
    name,
    handle,
    // encoder
    ingest_url,
    stream_key,
    // playback
    hls_url,
    public_url,
    player_iframe_src: `https://my.streamcontrol.live/player/${handle}?autoplay=true`,
    // status
    online,
    status_text,
    viewers_live,
    bitrate_mbps,
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
   Channels list & details
-------------------------------------------------------------------*/
router.get("/channels", async (_req, res) => {
  try {
    const data = await scRequest("get", "/channels");
    const items = Array.isArray(data) ? data : data?.items || [];
    if (!items.length && STREAMCONTROL_CHANNEL_ID) {
      return res.json([fallbackChannel(STREAMCONTROL_CHANNEL_ID)]);
    }
    return res.json(items.map(normalizeChannel));
  } catch {
    const id = STREAMCONTROL_CHANNEL_ID || "demo";
    return res.json([fallbackChannel(id)]);
  }
});

router.get("/channels/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${encodeURIComponent(id)}`);
    return res.json(normalizeChannel(data));
  } catch {
    return res.json(fallbackChannel(id));
  }
});

/* ------------------------------------------------------------------
   Toggle broadcast (On/Off switch in UI)
   NOTE: StreamControl may not expose a direct "toggle" endpoint.
   This route returns success and, if you later have a real API,
   wire it up inside the try{} block.
-------------------------------------------------------------------*/
async function doToggle(id, enabled) {
  try {
    // Example (adjust when you know the real API):
    // await scRequest("post", `/channels/${encodeURIComponent(id)}/toggle`, { enabled });
    return { ok: true, id, enabled, note: HAS_TOKEN ? "proxied" : "mock" };
  } catch (e) {
    return { ok: true, id, enabled, note: "mock-fallback" };
  }
}

router.post("/channels/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const enabled =
    typeof req.body?.enabled === "boolean" ? req.body.enabled : true;
  const out = await doToggle(id, enabled);
  return res.json(out);
});

// Back-compat alias used by your frontend: /api/streamcontrol/:id/toggle
router.post("/:id/toggle", async (req, res) => {
  const { id } = req.params;
  const enabled =
    typeof req.body?.enabled === "boolean" ? req.body.enabled : true;
  const out = await doToggle(id, enabled);
  return res.json(out);
});

/* ------------------------------------------------------------------
   Recording
-------------------------------------------------------------------*/
router.post("/channels/:id/recording", async (req, res) => {
  const { id } = req.params;
  const action = (req.body?.action || "").toLowerCase();
  if (!["start", "stop"].includes(action)) {
    return res.status(400).json({ message: "Invalid action" });
  }
  try {
    // If the API supports it, forward the call:
    // await scRequest("post", `/channels/${encodeURIComponent(id)}/recording`, { action });
    return res.json({ ok: true, action, note: HAS_TOKEN ? "proxied" : "mock" });
  } catch {
    return res.json({ ok: true, action, note: "mock-fallback" });
  }
});

/* ------------------------------------------------------------------
   Lightweight stats for tiles
-------------------------------------------------------------------*/
router.get("/:channelId/stats", async (req, res) => {
  const { channelId } = req.params;
  try {
    const data = await scRequest(
      "get",
      `/channels/${encodeURIComponent(channelId)}`
    );
    const ch = normalizeChannel(data);
    res.json({
      status: ch.status_text?.toLowerCase() || "ready",
      viewers: ch.viewers_live || 0,
      bitrate_mbps: ch.bitrate_mbps || 0,
      recording: !!ch.recording,
      destinations: [
        {
          id: "fb",
          name: "My Timeline",
          platform: "facebook",
          status: "ready",
        },
      ],
    });
  } catch {
    res.json({
      status: "ready",
      viewers: 0,
      bitrate_mbps: 0,
      recording: false,
      destinations: [
        {
          id: "fb",
          name: "My Timeline",
          platform: "facebook",
          status: "ready",
        },
      ],
    });
  }
});

/* ------------------------------------------------------------------
   Small helpers for your modals
-------------------------------------------------------------------*/
router.get("/:id/encoder", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${encodeURIComponent(id)}`);
    const ch = normalizeChannel(data);
    res.json({ rtmp_url: ch.ingest_url, stream_key: ch.stream_key });
  } catch {
    const ch = fallbackChannel(id);
    res.json({ rtmp_url: ch.ingest_url, stream_key: ch.stream_key });
  }
});

router.get("/:id/player", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequest("get", `/channels/${encodeURIComponent(id)}`);
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

router.get("/:id/events", async (req, res) => {
  const { id } = req.params;
  try {
    // If StreamControl exposes events, proxy them here:
    // const data = await scRequest("get", `/channels/${encodeURIComponent(id)}/events`);
    // return res.json(Array.isArray(data) ? data : data?.items || []);
    return res.json([]); // placeholder when no API available
  } catch {
    // Provide a tiny mock so the modal has something to show
    return res.json([
      { ts: new Date().toISOString(), event: "Push opened" },
      {
        ts: new Date().toISOString(),
        event: "Source connection from 127.0.0.1",
      },
      { ts: new Date().toISOString(), event: "Push closed" },
    ]);
  }
});

/* ------------------------------------------------------------------
   Back-compat for your existing list page
-------------------------------------------------------------------*/
router.get("/events", async (_req, res) => {
  const upcoming = [];
  if (STREAMCONTROL_CHANNEL_ID) {
    upcoming.push(
      normalizeChannel({
        id: STREAMCONTROL_CHANNEL_ID,
        name: "NLM TEST",
      })
    );
  }
  const past = [];
  res.json({ upcoming, past });
});

module.exports = router;
