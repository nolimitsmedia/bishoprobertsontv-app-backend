const express = require("express");
const router = express.Router();
const db = require("../db");
// Phase 8-1: Administrators and Website Managers.
const { requireArea } = require("../lib/teamAccess");
const authenticateAdmin = requireArea("website");

const DEFAULTS = Object.freeze({
  fontFamily: "Inter",
  baseFontSize: 16,
  accentColor: "#7C3AED",
});
const VALID_FONT = /^[a-zA-Z0-9 ,+.'-]{2,80}$/;
function validate(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid settings");
  const fontFamily = String(input.fontFamily ?? DEFAULTS.fontFamily).trim();
  const baseFontSize = Number(input.baseFontSize ?? DEFAULTS.baseFontSize);
  const accentColor = String(input.accentColor ?? DEFAULTS.accentColor)
    .trim()
    .toUpperCase();
  if (!VALID_FONT.test(fontFamily)) throw new Error("Invalid font family");
  if (!Number.isInteger(baseFontSize) || baseFontSize < 10 || baseFontSize > 36)
    throw new Error("Font size must be 10–36px");
  if (!/^#[0-9A-F]{6}$/.test(accentColor))
    throw new Error("Use a six-digit HEX color");
  return { fontFamily, baseFontSize, accentColor };
}
router.get("/public", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key='global'",
    );
    res.json({
      ok: true,
      settings: { ...DEFAULTS, ...(rows[0]?.published_json || {}) },
    });
  } catch (err) {
    console.error("[site-design:public]", err);
    res.status(500).json({ ok: false, error: "Design settings unavailable" });
  }
});
router.get("/admin", authenticateAdmin, async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    const { rows } = await db.query(
      "SELECT draft_json,published_json,updated_at,published_at FROM site_design_settings WHERE setting_key='global'",
    );
    res.json({
      ok: true,
      draft: {
        ...DEFAULTS,
        ...(rows[0]?.draft_json || rows[0]?.published_json || {}),
      },
      published: { ...DEFAULTS, ...(rows[0]?.published_json || {}) },
      updated_at: rows[0]?.updated_at || null,
      published_at: rows[0]?.published_at || null,
    });
  } catch (err) {
    console.error("[site-design:admin]", err);
    res
      .status(500)
      .json({ ok: false, error: "Unable to load design settings" });
  }
});
router.put("/admin", authenticateAdmin, async (req, res) => {
  let settings;
  try {
    settings = validate(req.body);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  try {
    await db.query(
      `INSERT INTO site_design_settings (setting_key,draft_json) VALUES ('global',$1::jsonb)
      ON CONFLICT (setting_key) DO UPDATE SET draft_json=EXCLUDED.draft_json,updated_at=NOW()`,
      [JSON.stringify(settings)],
    );
    res.json({ ok: true, settings });
  } catch (err) {
    console.error("[site-design:save]", err);
    res.status(500).json({ ok: false, error: "Unable to save design draft" });
  }
});
router.post("/admin/publish", authenticateAdmin, async (_req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE site_design_settings SET published_json=draft_json,published_at=NOW(),updated_at=NOW() WHERE setting_key='global' AND draft_json IS NOT NULL RETURNING published_json`,
    );
    if (!rows.length)
      return res.status(409).json({ ok: false, error: "Save a draft first" });
    res.json({ ok: true, settings: rows[0].published_json });
  } catch (err) {
    console.error("[site-design:publish]", err);
    res.status(500).json({ ok: false, error: "Unable to publish design" });
  }
});
module.exports = router;
