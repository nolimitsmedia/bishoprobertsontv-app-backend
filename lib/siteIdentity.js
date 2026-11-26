// server-api/lib/siteIdentity.js
// The ministry's name, color and logo as set in Site Settings › Brand
// (site_design_settings 'site_options'), then the older site_settings row,
// then the server's SITE_NAME setting. Cached for a minute.
const db = require("../db");

const FALLBACK_NAME = () =>
  (process.env.SITE_NAME || "").trim() || "Our Ministry";
let cache = { at: 0, value: null };

async function siteBrand() {
  if (cache.value && Date.now() - cache.at < 60000) return cache.value;
  let opts = {};
  try {
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key = 'site_options' LIMIT 1",
    );
    const j = rows[0]?.published_json;
    opts = (typeof j === "string" ? JSON.parse(j) : j)?.brand || {};
  } catch {
    /* table may not exist yet */
  }
  let legacy = {};
  try {
    const { rows } = await db.query(
      "SELECT site_name, brand_color, logo_url FROM site_settings ORDER BY id DESC LIMIT 1",
    );
    legacy = rows[0] || {};
  } catch {
    /* table may not exist yet */
  }
  const hex = /^#[0-9a-fA-F]{6}$/;
  const value = {
    name: (opts.name || legacy.site_name || "").trim() || FALLBACK_NAME(),
    color: hex.test(opts.color || "")
      ? opts.color
      : hex.test(legacy.brand_color || "")
        ? legacy.brand_color
        : "",
    logo_url: opts.logo_url || legacy.logo_url || "",
  };
  cache = { at: Date.now(), value };
  return value;
}

async function siteName() {
  return (await siteBrand()).name;
}

module.exports = { siteBrand, siteName, FALLBACK_NAME };
