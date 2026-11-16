// server-api/services/durationSync.js
//
// Fill in video durations from Bunny Stream. Many videos were saved with no
// duration (0), so cards, the Home banner and Continue Watching could not show
// it. Asks Bunny for each video's real length (4 at a time) and saves it.
// Automatic: every 30 minutes for videos still missing a duration (covers new
// uploads); DURATION_SYNC_AUTO=off turns that off.

const fetch = require("node-fetch");
const db = require("../db");

const apiBase = () =>
  String(
    process.env.BUNNY_STREAM_API_BASE || "https://video.bunnycdn.com",
  ).replace(/\/+$/, "");
const apiKey = () => String(process.env.BUNNY_STREAM_API_KEY || "").trim();
const defaultLib = () =>
  String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim();
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const obj = (v) => {
  if (!v) return {};
  if (typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};

// The Bunny video id and library, wherever this video keeps them.
function bunnyRef(row) {
  const meta = obj(row.metadata);
  const src = obj(row.source_meta);
  const imp = obj(meta.bunny_stream_import);
  const direct = [
    row.bunny_video_id,
    meta.bunny_video_id,
    imp.bunny_video_id,
    src.bunny_video_id,
  ].find((x) => x && GUID.test(String(x)));
  let guid = direct ? String(direct).match(GUID)[0] : "";
  if (!guid) {
    for (const u of [
      row.embed_url,
      imp.embed_url,
      src.embed_url,
      row.playback_url,
      row.video_url,
      src.hls_url,
    ]) {
      const s = String(u || "");
      if (/mediadelivery\.net|b-cdn\.net/i.test(s) && GUID.test(s)) {
        guid = s.match(GUID)[0];
        break;
      }
    }
  }
  let lib = String(
    row.bunny_library_id || imp.bunny_library_id || src.bunny_library_id || "",
  ).trim();
  if (!lib) {
    const m = String(
      row.embed_url || imp.embed_url || src.embed_url || "",
    ).match(/\/embed\/(\d+)\//);
    lib = m ? m[1] : defaultLib();
  }
  return guid && lib ? { guid, lib } : null;
}

async function bunnyLength({ lib, guid }) {
  const r = await fetch(`${apiBase()}/library/${lib}/videos/${guid}`, {
    headers: { AccessKey: apiKey(), Accept: "application/json" },
  });
  if (r.status === 404) return { missing: true };
  if (!r.ok) throw new Error(`Bunny ${r.status}`);
  const d = await r.json();
  return { length: Math.round(Number(d?.length) || 0), status: d?.status };
}

let state = { running: false, startedAt: null, finishedAt: null, result: null };

async function run({ all = false } = {}) {
  if (state.running) return state;
  if (!apiKey())
    throw new Error("Bunny Stream is not configured (BUNNY_STREAM_API_KEY)");
  state = {
    running: true,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
  };
  const result = {
    checked: 0,
    updated: 0,
    still_processing: 0,
    not_on_bunny: 0,
    no_bunny_id: 0,
    failed: 0,
  };
  try {
    const { rows } = await db.query(
      `SELECT * FROM videos ${all ? "" : "WHERE COALESCE(duration_seconds, 0) <= 0"} ORDER BY id DESC LIMIT 5000`,
    );
    const queue = [...rows];
    const worker = async () => {
      while (queue.length) {
        const row = queue.shift();
        const ref = bunnyRef(row);
        if (!ref) {
          result.no_bunny_id += 1;
          continue;
        }
        result.checked += 1;
        try {
          const b = await bunnyLength(ref);
          if (b.missing) result.not_on_bunny += 1;
          else if (b.length > 0) {
            if (Number(row.duration_seconds) !== b.length) {
              await db.query(
                "UPDATE videos SET duration_seconds = $2 WHERE id = $1",
                [row.id, b.length],
              );
              result.updated += 1;
            }
          } else result.still_processing += 1;
        } catch (e) {
          result.failed += 1;
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    state = {
      ...state,
      running: false,
      finishedAt: new Date().toISOString(),
      result,
    };
  }
  return state;
}

const status = () => state;

function startAuto() {
  if (String(process.env.DURATION_SYNC_AUTO || "").toLowerCase() === "off")
    return null;
  const tick = () => {
    if (!apiKey()) return;
    run().catch((e) => console.warn("[durations] auto sync:", e.message));
  };
  const t = setInterval(tick, 30 * 60 * 1000);
  t.unref?.();
  setTimeout(tick, 90 * 1000).unref?.();
  return t;
}

module.exports = { run, status, startAuto, bunnyRef };
