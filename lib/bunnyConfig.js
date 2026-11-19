// server-api/lib/bunnyConfig.js
//
// The customer's own Bunny Stream library (pasted on the Cloud Storage page),
// stored encrypted in site_design_settings ('bunny_connection'). When set, it
// is applied over the Render environment (BUNNY_STREAM_LIBRARY_ID,
// BUNNY_STREAM_API_KEY, BUNNY_STREAM_CDN_HOST) at start-up and on every save,
// so the whole app (uploads, imports, player, durations, preview clips) uses
// it without a restart. With nothing saved, the environment is used as before.
const db = require("../db");
const { seal, open, mask } = require("./secretBox");

const KEY = "bunny_connection";
const ENV_NAMES = [
  "BUNNY_STREAM_LIBRARY_ID",
  "BUNNY_STREAM_API_KEY",
  "BUNNY_STREAM_CDN_HOST",
];
const original = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
let current = null; // { library_id, api_key, cdn_host, connected_at } or null

async function ensureTable() {
  await db.query(`CREATE TABLE IF NOT EXISTS site_design_settings (
    setting_key text PRIMARY KEY, draft_json jsonb, published_json jsonb, updated_at timestamptz DEFAULT now())`);
}

function apply() {
  const c = current;
  process.env.BUNNY_STREAM_LIBRARY_ID =
    c?.library_id || original.BUNNY_STREAM_LIBRARY_ID || "";
  process.env.BUNNY_STREAM_API_KEY =
    c?.api_key || original.BUNNY_STREAM_API_KEY || "";
  if (c?.cdn_host) process.env.BUNNY_STREAM_CDN_HOST = c.cdn_host;
  else if (original.BUNNY_STREAM_CDN_HOST)
    process.env.BUNNY_STREAM_CDN_HOST = original.BUNNY_STREAM_CDN_HOST;
  else delete process.env.BUNNY_STREAM_CDN_HOST;
  // bunnyStream.js keeps its own copies: refresh them
  try {
    require("../routes/bunnyStream").refreshBunnyConfig?.();
  } catch {
    /* not loaded yet */
  }
}

async function load() {
  try {
    await ensureTable();
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key = $1",
      [KEY],
    );
    const blob = rows[0]?.published_json?.sealed;
    current = blob ? open(blob, "bunny-connection") : null;
    if (current && !current.library_id) current = null;
  } catch (e) {
    console.warn("[bunnyConfig] load:", e.message);
  }
  apply();
  return current;
}

async function save({ library_id, api_key, cdn_host }) {
  await ensureTable();
  const next = {
    library_id: String(library_id || "").trim(),
    api_key: String(api_key || "").trim() || current?.api_key || "",
    cdn_host: String(cdn_host || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, ""),
    connected_at: new Date().toISOString(),
  };
  await db.query(
    `INSERT INTO site_design_settings (setting_key, published_json, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (setting_key) DO UPDATE SET published_json = EXCLUDED.published_json, updated_at = now()`,
    [KEY, JSON.stringify({ sealed: seal(next, "bunny-connection") })],
  );
  current = next;
  apply();
  return status();
}

async function remove() {
  await ensureTable();
  await db.query("DELETE FROM site_design_settings WHERE setting_key = $1", [
    KEY,
  ]);
  current = null;
  apply();
  return status();
}

// what the admin page may see (never the key itself)
function status() {
  const lib = process.env.BUNNY_STREAM_LIBRARY_ID || "";
  return {
    source: current ? "connected" : lib ? "server" : "none", // connected here | server settings | nothing
    library_id: lib || "",
    api_key: mask(process.env.BUNNY_STREAM_API_KEY),
    cdn_host:
      process.env.BUNNY_STREAM_CDN_HOST || (lib ? `vz-${lib}.b-cdn.net` : ""),
    connected_at: current?.connected_at || null,
  };
}

module.exports = { load, save, remove, status };
