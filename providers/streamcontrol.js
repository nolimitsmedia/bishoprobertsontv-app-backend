// server-api/providers/streamcontrol.js
const crypto = require("crypto");

const RTMP_BASE = String(process.env.STREAMCONTROL_RTMP_URL || "").replace(
  /\/+$/,
  ""
);
const HLS_TEMPLATE = String(process.env.STREAMCONTROL_HLS_TEMPLATE || "");
const NAME = "streamcontrol";

/** Strong, URL-safe stream key */
function makeStreamKey() {
  return "ch_" + crypto.randomBytes(10).toString("base64url"); // e.g. ch_Fs9lP8-...
}

/** Build ingest + playback URLs from the stream key/name */
function urlsFor(streamKey) {
  const rtmp_ingest = `${RTMP_BASE}/${streamKey}`;
  const hls_url = HLS_TEMPLATE
    ? HLS_TEMPLATE.replace("{name}", streamKey).replace("{key}", streamKey)
    : null;
  return { rtmp_ingest, hls_url };
}

/**
 * Create a "live event" on Streamcontrol (template mode).
 * If you later expose a Streamcontrol REST API, you can replace this with a POST that returns a name/key.
 */
async function createLive({ title, description, user }) {
  const stream_key = makeStreamKey();
  const { rtmp_ingest, hls_url } = urlsFor(stream_key);

  return {
    name: NAME,
    status: "scheduled",
    stream_key,
    rtmp_ingest,
    hls_url,
    provider_data: { stream_key }, // keep minimal; expand if you add API calls
  };
}

/** Mark started (no-op for template mode) */
async function startLive(_eventRow) {
  return { status: "live" };
}

/** Mark ended (no-op for template mode) */
async function endLive(_eventRow) {
  // If you do server-side recording & VOD creation, return { vod_video_id }
  return { status: "ended", vod_video_id: null };
}

module.exports = {
  name: NAME,
  createLive,
  startLive,
  endLive,
  urlsFor,
};
