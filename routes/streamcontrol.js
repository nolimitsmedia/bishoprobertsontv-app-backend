// server-api/routes/streamcontrol.js
const express = require("express");
const router = express.Router();
const axios = require("axios");

/* ------------------------------------------------------------------
   ENV
-------------------------------------------------------------------*/
const {
  STREAMCONTROL_API_TOKEN,
  STREAMCONTROL_API_BASE, // e.g. https://my.streamcontrol.live (NO /v1)
  STREAMCONTROL_CHANNEL_ID,
  STREAMCONTROL_RTMP_URL,
  STREAMCONTROL_STREAM_KEY,
  STREAMCONTROL_HLS_URL,
  STREAMCONTROL_PUBLIC_URL,
} = process.env;

/**
 * IMPORTANT:
 * StreamControl deployments differ. Some use /v1, some do not.
 * We'll support both by:
 *  - Keeping base WITHOUT trailing /v1 by default
 *  - Trying both prefix "" and "/v1" when calling endpoints
 */
const RAW_BASE = (
  STREAMCONTROL_API_BASE || "https://my.streamcontrol.live"
).replace(/\/+$/, "");

// If user accidentally set base ending in /v1, strip it (we'll try it dynamically)
const API_BASE = RAW_BASE.replace(/\/v1$/i, "");

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

async function scRequest(method, url, data) {
  if (!HAS_TOKEN) {
    const err = new Error("NO_TOKEN");
    err.code = "NO_TOKEN";
    throw err;
  }
  const res = await sc.request({ method, url, data });
  return res.data;
}

/* ------------------------------------------------------------------
   Error Helpers
-------------------------------------------------------------------*/
function isNoToken(err) {
  return err?.code === "NO_TOKEN" || err?.message === "NO_TOKEN";
}

function isNetworkUnreachable(err) {
  const code = err?.code || err?.cause?.code;
  return (
    code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ETIMEDOUT"
  );
}

function isRouteNotFound(err) {
  // StreamControl often returns JSON: { message: 'The route ... could not be found.' }
  const msg = err?.response?.data?.message || err?.message || "";
  return (
    err?.response?.status === 404 ||
    /could not be found/i.test(msg) ||
    /route .* could not be found/i.test(msg)
  );
}

/**
 * Try both with and without /v1. This prevents the "v1/..." route-not-found error.
 */
async function scRequestAnyVersion(method, path, data) {
  // try without /v1 first
  try {
    return await scRequest(method, path, data);
  } catch (e1) {
    if (!isRouteNotFound(e1)) throw e1;
  }

  // then try with /v1
  return await scRequest(method, `/v1${path}`, data);
}

/* ------------------------------------------------------------------
   DB Helper (kept)
-------------------------------------------------------------------*/
function getDb(req) {
  if (req?.db && typeof req.db.query === "function") return req.db;

  try {
    const mod = require("../db");
    if (mod && typeof mod.query === "function") return mod;
    if (mod && mod.pool && typeof mod.pool.query === "function")
      return mod.pool;
  } catch (_e) {}
  return null;
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

  const metrics = payload.metrics || {};
  const online =
    payload.online ?? payload.is_online ?? payload.status === "online" ?? false;

  const viewers_live =
    metrics.current_viewers ?? metrics.viewers_live ?? metrics.viewers ?? 0;

  let bitrate_mbps = 0;
  if (typeof metrics.bitrate_mbps === "number")
    bitrate_mbps = metrics.bitrate_mbps;
  else if (typeof metrics.bitrate_kbps === "number")
    bitrate_mbps = metrics.bitrate_kbps / 1000;

  const starting_for_sec = Number(
    metrics.uptime_sec ||
      metrics.broadcast_time_sec ||
      metrics.live_seconds ||
      0
  );

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
    status_text: payload.status_text || (online ? "Online" : "Ready"),
    viewers_live,
    bitrate_mbps,
    starting_for_sec,
    recording,
    quality:
      payload.profile ||
      payload.live_profile ||
      payload.output_profile ||
      metrics.profile ||
      "",
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
   NEXT LIVE (from Admin Calendar)
   - Robust DB fallbacks because table/columns differ between builds
-------------------------------------------------------------------*/

async function tryQuery(db, text, params) {
  const r = await db.query(text, params);
  return r?.rows || [];
}

function toIsoSafe(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Attempts to find the next LIVE schedule item.
 * Returns: { id, title, start_at, end_at, type } OR null
 */
async function getNextLiveFromDb(db) {
  const now = new Date();

  // Candidate tables + column layouts we try in order.
  // The goal: find next upcoming item where type/category indicates LIVE.
  const candidates = [
    // Common pattern A
    {
      name: "admin_calendar_items",
      sql: `
        SELECT
          id,
          COALESCE(title, name) AS title,
          start_time AS start_at,
          end_time   AS end_at,
          COALESCE(type, category) AS type
        FROM admin_calendar_items
        WHERE start_time IS NOT NULL
          AND start_time > $1
          AND (COALESCE(type, category, '') ILIKE 'live%' OR COALESCE(type, category, '') ILIKE '%live%')
        ORDER BY start_time ASC
        LIMIT 1
      `,
    },
    // Pattern B
    {
      name: "calendar_items",
      sql: `
        SELECT
          id,
          COALESCE(title, name) AS title,
          start_time AS start_at,
          end_time   AS end_at,
          COALESCE(type, category) AS type
        FROM calendar_items
        WHERE start_time IS NOT NULL
          AND start_time > $1
          AND (COALESCE(type, category, '') ILIKE 'live%' OR COALESCE(type, category, '') ILIKE '%live%')
        ORDER BY start_time ASC
        LIMIT 1
      `,
    },
    // Pattern C
    {
      name: "calendar_events",
      sql: `
        SELECT
          id,
          COALESCE(title, name) AS title,
          start_at AS start_at,
          end_at   AS end_at,
          COALESCE(type, category) AS type
        FROM calendar_events
        WHERE start_at IS NOT NULL
          AND start_at > $1
          AND (COALESCE(type, category, '') ILIKE 'live%' OR COALESCE(type, category, '') ILIKE '%live%')
        ORDER BY start_at ASC
        LIMIT 1
      `,
    },
    // Pattern D (some apps name it live_events)
    {
      name: "live_events",
      sql: `
        SELECT
          id,
          COALESCE(title, name) AS title,
          start_time AS start_at,
          end_time   AS end_at,
          COALESCE(type, category, 'LIVE') AS type
        FROM live_events
        WHERE start_time IS NOT NULL
          AND start_time > $1
        ORDER BY start_time ASC
        LIMIT 1
      `,
    },
    // Pattern E (very generic: "events")
    {
      name: "events",
      sql: `
        SELECT
          id,
          COALESCE(title, name) AS title,
          start_time AS start_at,
          end_time   AS end_at,
          COALESCE(type, category, '') AS type
        FROM events
        WHERE start_time IS NOT NULL
          AND start_time > $1
          AND (COALESCE(type, category, '') ILIKE 'live%' OR COALESCE(type, category, '') ILIKE '%live%')
        ORDER BY start_time ASC
        LIMIT 1
      `,
    },
  ];

  for (const c of candidates) {
    try {
      const rows = await tryQuery(db, c.sql, [now]);
      if (rows && rows.length) {
        const r = rows[0];
        return {
          id: r.id,
          title: r.title || "Live Stream",
          type: r.type || "LIVE",
          start_at: toIsoSafe(r.start_at),
          end_at: toIsoSafe(r.end_at),
          _source_table: c.name,
        };
      }
    } catch (_e) {
      // table/column doesn't exist -> try next
    }
  }

  // Nothing found
  return null;
}

/**
 * GET /api/streamcontrol/:channelId/next-live
 * Used by LivePage countdown.
 */
router.get("/:channelId/next-live", async (req, res) => {
  const db = getDb(req);
  if (!db) {
    return res.json({ ok: true, nextLive: null, warning: "DB_NOT_AVAILABLE" });
  }

  try {
    const nextLive = await getNextLiveFromDb(db);

    if (!nextLive?.start_at) {
      return res.json({ ok: true, nextLive: null });
    }

    const startMs = new Date(nextLive.start_at).getTime();
    const nowMs = Date.now();

    return res.json({
      ok: true,
      nextLive: {
        id: nextLive.id,
        title: nextLive.title,
        type: nextLive.type,
        start_at: nextLive.start_at,
        end_at: nextLive.end_at,
        starts_in_ms: Math.max(0, startMs - nowMs),
      },
      // helpful for debugging (safe)
      source: nextLive._source_table,
    });
  } catch (e) {
    console.error("next-live error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "NEXT_LIVE_FAILED" });
  }
});

/* ------------------------------------------------------------------
   CHANNELS
-------------------------------------------------------------------*/
router.get("/channels", async (_req, res) => {
  try {
    const data = await scRequestAnyVersion("get", "/channels");
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
    const data = await scRequestAnyVersion("get", `/channels/${id}`);
    return res.json(normalizeChannel(data));
  } catch {
    return res.json(fallbackChannel(id));
  }
});

/* ------------------------------------------------------------------
   STATS (kept)
-------------------------------------------------------------------*/
router.get("/:channelId/stats", async (req, res) => {
  const { channelId } = req.params;
  try {
    const data = await scRequestAnyVersion("get", `/channels/${channelId}`);
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
   PUBLISHERS (robust multi-endpoint)
-------------------------------------------------------------------*/

/**
 * StreamControl varies:
 *  - /channels/:id/publishers
 *  - /channels/:id/destinations
 *  - /channels/:id/restreams
 *
 * We'll try all three (w/ and w/out /v1) and normalize to publishers[].
 */
async function fetchPublishers(channelId) {
  const candidates = [
    `/channels/${channelId}/publishers`,
    `/channels/${channelId}/destinations`,
    `/channels/${channelId}/restreams`,
  ];

  let lastErr = null;

  for (const path of candidates) {
    try {
      const data = await scRequestAnyVersion("get", path);

      const items = Array.isArray(data)
        ? data
        : data?.items ||
          data?.publishers ||
          data?.destinations ||
          data?.restreams ||
          [];

      // Normalize each item shape a bit
      const publishers = (items || []).map((x) => ({
        id: x.id || x.publisher_id || x.destination_id || x.restream_id,
        name: x.name || x.title || x.platform || x.provider || "Destination",
        enabled: x.enabled ?? x.active ?? x.is_enabled ?? true,
        platform: x.platform || x.provider || x.type || null,
        raw: x,
      }));

      return { publishers, sourcePath: path };
    } catch (err) {
      lastErr = err;

      // If it is a clean 404/route-not-found, continue trying next candidate
      if (isRouteNotFound(err)) continue;

      // Anything else: throw (auth/network/etc)
      throw err;
    }
  }

  // none of the endpoints exist on this API
  if (lastErr) throw lastErr;
  return { publishers: [], sourcePath: null };
}

router.get("/:channelId/publishers", async (req, res) => {
  const { channelId } = req.params;

  try {
    const { publishers, sourcePath } = await fetchPublishers(channelId);
    return res.json({ ok: true, publishers, source: sourcePath });
  } catch (err) {
    if (isNoToken(err)) {
      return res.json({
        ok: true,
        publishers: [],
        warning: "STREAMCONTROL_API_TOKEN not set; publishers disabled in dev.",
      });
    }

    if (isNetworkUnreachable(err)) {
      const code = err?.code || err?.cause?.code;
      return res.json({
        ok: true,
        publishers: [],
        warning: `StreamControl unreachable (${code}).`,
      });
    }

    // If it's just route-not-found everywhere, don't crash the UI
    if (isRouteNotFound(err)) {
      return res.json({
        ok: true,
        publishers: [],
        warning: "Publishers endpoint not available on this StreamControl API.",
      });
    }

    console.error("publishers list error", err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: "PUBLISHERS_LIST_FAILED" });
  }
});

/**
 * This StreamControl deployment doesn't support publisher creation via API.
 * Keep stable responses so UI can show a friendly message.
 */
router.post("/:channelId/publishers", async (_req, res) => {
  return res.status(400).json({
    ok: false,
    error: "PUBLISHER_CREATE_NOT_SUPPORTED",
    message:
      "Publishers must be added in the StreamControl dashboard. Use the StreamControl UI to add destinations.",
  });
});

router.post("/:channelId/publishers/:pubId/toggle", async (_req, res) => {
  return res.status(400).json({
    ok: false,
    error: "PUBLISHER_TOGGLE_NOT_SUPPORTED",
    message:
      "Publisher enable/disable must be managed in the StreamControl dashboard.",
  });
});

router.delete("/:channelId/publishers/:pubId", async (_req, res) => {
  return res.status(400).json({
    ok: false,
    error: "PUBLISHER_DELETE_NOT_SUPPORTED",
    message: "Publishers must be removed in the StreamControl dashboard.",
  });
});

/* ------------------------------------------------------------------
   Optional: Encoder + Player (kept)
-------------------------------------------------------------------*/
router.get("/:id/encoder", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequestAnyVersion("get", `/channels/${id}`);
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

router.get("/:id/player", async (req, res) => {
  const { id } = req.params;
  try {
    const data = await scRequestAnyVersion("get", `/channels/${id}`);
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
   Legacy placeholders
-------------------------------------------------------------------*/
router.get("/:id/events", async (_req, res) => res.json([]));
router.get("/events", async (_req, res) =>
  res.json({ upcoming: [], past: [] })
);

module.exports = router;
