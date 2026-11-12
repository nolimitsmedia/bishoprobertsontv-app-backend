// server-api/routes/siteOptions.js
//
// Site options (like WordPress "Reading" and "Additional CSS"):
//   home_page_slug  which page the site's home ("/") shows; "" = the built-in Home
//   custom_css      site-wide custom CSS
//   brand / header / footer  Release 1.3: site identity (white-label) and the
//                   site-wide header and footer
//   global_colors   brand palette [{ slug, name, hex }] (Release 1.2), used as
//                   linked colors var(--bx-gc-<slug>) in the visual editor
// Stored in site_design_settings under setting_key='site_options' (the table
// already exists; no migration). Saved values apply immediately.
//
//   GET /api/site-options/public   public read (used by the website)
//   GET /api/site-options/admin    administrators and Website Managers
//   PUT /api/site-options/admin    administrators and Website Managers

const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireArea } = require("../lib/teamAccess");

const KEY = "site_options";
const DEFAULTS = {
  home_page_slug: "",
  custom_css: "",
  global_colors: [],
  brand: {},
  header: {},
  footer: {},
  featured: [],
};
const MAX_CSS = 50000;

// Custom CSS cannot run scripts in modern browsers; this also removes ways to
// break out of the <style> element or pull in outside code.
function cleanCss(input) {
  return String(input || "")
    .slice(0, MAX_CSS)
    .replace(/<\/?\s*style[^>]*>/gi, "")
    .replace(/<\/?\s*script[^>]*>/gi, "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/-moz-binding\s*:/gi, "")
    .replace(/behavior\s*:/gi, "");
}

function cleanSlug(input) {
  const s = String(input || "")
    .trim()
    .toLowerCase();
  if (!s) return "";
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(s) ? s : null;
}

// Up to 12 named colors; slugs are lowercase letters, digits and dashes.
function cleanColors(input) {
  if (!Array.isArray(input) || input.length > 12) return null;
  const out = [];
  const seen = new Set();
  for (const c of input) {
    const slug = String(c?.slug || "")
      .trim()
      .toLowerCase();
    const name = String(c?.name || "")
      .trim()
      .slice(0, 40);
    const hex = String(c?.hex || "").trim();
    if (
      !/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug) ||
      !name ||
      !/^#[0-9a-fA-F]{6}$/.test(hex) ||
      seen.has(slug)
    )
      return null;
    seen.add(slug);
    out.push({ slug, name, hex: hex.toLowerCase() });
  }
  return out;
}

// ---- Release 1.3: brand, header, footer (validated field by field) ----
const str = (v, max) =>
  String(v ?? "")
    .trim()
    .slice(0, max);
const color = (v) => {
  const s = str(v, 60);
  return /^#[0-9a-fA-F]{6}$/.test(s) ||
    /^var\(--bx-gc-[a-z0-9-]{1,40}\)$/.test(s)
    ? s
    : "";
};
// Links: a page on the site, an https address, email or phone.
const link = (v) => {
  const s = str(v, 500);
  return /^\/[^\s<>"']*$/.test(s) ||
    /^https:\/\/[^\s<>"']+$/i.test(s) ||
    /^(mailto|tel):[^\s<>"']+$/i.test(s)
    ? s
    : "";
};
// Images: https, or a path on this site (Media Library uploads).
const image = (v) => {
  const s = str(v, 800);
  return /^https:\/\/[^\s<>"']+$/i.test(s) || /^\/[^\s<>"']+$/.test(s) ? s : "";
};
const bool = (v, d) => (v === undefined ? d : v === true);
const SOCIAL_NETWORKS = new Set([
  "facebook",
  "instagram",
  "youtube",
  "x",
  "tiktok",
  "linkedin",
  "email",
  "website",
  "phone",
]);

function cleanBrand(b) {
  b = b && typeof b === "object" ? b : {};
  return {
    name: str(b.name, 80),
    logo_url: image(b.logo_url),
    tagline: str(b.tagline, 160),
    contact_email: /^[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}$/.test(
      str(b.contact_email, 200),
    )
      ? str(b.contact_email, 200)
      : "",
  };
}
function cleanHeader(h) {
  h = h && typeof h === "object" ? h : {};
  return {
    bg: color(h.bg),
    text: color(h.text),
    sticky: bool(h.sticky, true),
    logo_height: Math.min(
      96,
      Math.max(24, Number.parseInt(h.logo_height, 10) || 44),
    ),
    topbar_enabled: bool(h.topbar_enabled, false),
    topbar_text: str(h.topbar_text, 160),
    topbar_link: link(h.topbar_link),
    topbar_bg: color(h.topbar_bg),
    topbar_color: color(h.topbar_color),
    button_label: str(h.button_label, 40),
    button_link: link(h.button_link),
  };
}
// Release 2.0: Browse hero — up to 8 videos, each with an optional wide image.
function cleanFeatured(list) {
  return (Array.isArray(list) ? list : [])
    .slice(0, 8)
    .map((f) => ({
      video_id: Number.parseInt(f?.video_id, 10),
      image_url: image(f?.image_url),
    }))
    .filter(
      (f, i, arr) =>
        Number.isSafeInteger(f.video_id) &&
        f.video_id > 0 &&
        arr.findIndex((x) => x.video_id === f.video_id) === i,
    );
}

function cleanFooter(f) {
  f = f && typeof f === "object" ? f : {};
  const columns = (Array.isArray(f.columns) ? f.columns : [])
    .slice(0, 3)
    .map((c) => ({
      title: str(c?.title, 60),
      links: (Array.isArray(c?.links) ? c.links : [])
        .slice(0, 8)
        .map((l) => ({ label: str(l?.label, 60), to: link(l?.to) }))
        .filter((l) => l.label && l.to),
    }));
  const socials = (Array.isArray(f.socials) ? f.socials : [])
    .slice(0, 9)
    .map((x) => ({ network: str(x?.network, 20), url: str(x?.url, 500) }))
    .filter(
      (x) =>
        SOCIAL_NETWORKS.has(x.network) &&
        x.url &&
        !/[<>"'\s]/.test(x.url) &&
        !/^javascript:/i.test(x.url),
    );
  return {
    bg: color(f.bg),
    text: color(f.text),
    columns,
    socials,
    copyright: str(f.copyright, 160),
    show_powered_by: bool(f.show_powered_by, true),
  };
}

async function readOptions() {
  const { rows } = await db.query(
    "SELECT published_json FROM site_design_settings WHERE setting_key = $1",
    [KEY],
  );
  return { ...DEFAULTS, ...(rows[0]?.published_json || {}) };
}

router.get("/public", async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, options: await readOptions() });
  } catch (e) {
    // The website keeps working with defaults if options are unavailable.
    console.error("[siteOptions] public read failed:", e?.message || e);
    res.json({ ok: true, options: { ...DEFAULTS } });
  }
});

router.get("/admin", requireArea("website"), async (_req, res) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, options: await readOptions() });
  } catch (e) {
    console.error("[siteOptions] admin read failed:", e);
    res.status(500).json({ ok: false, error: "Unable to load site options" });
  }
});

router.put("/admin", requireArea("website"), async (req, res) => {
  try {
    const current = await readOptions();
    const next = { ...current };
    if (req.body?.home_page_slug !== undefined) {
      const slug = cleanSlug(req.body.home_page_slug);
      if (slug === null)
        return res
          .status(400)
          .json({ ok: false, error: "Choose a valid page" });
      if (slug) {
        const { rows } = await db.query(
          "SELECT 1 FROM pages WHERE slug = $1 LIMIT 1",
          [slug],
        );
        if (!rows.length)
          return res
            .status(400)
            .json({ ok: false, error: "That page does not exist" });
      }
      next.home_page_slug = slug;
    }
    if (req.body?.global_colors !== undefined) {
      const colors = cleanColors(req.body.global_colors);
      if (colors === null)
        return res.status(400).json({
          ok: false,
          error:
            "Global colors: up to 12, each with a name and a #rrggbb color (names must be different)",
        });
      next.global_colors = colors;
    }
    if (req.body?.brand !== undefined) next.brand = cleanBrand(req.body.brand);
    if (req.body?.header !== undefined)
      next.header = cleanHeader(req.body.header);
    if (req.body?.footer !== undefined)
      next.footer = cleanFooter(req.body.footer);
    if (req.body?.featured !== undefined)
      next.featured = cleanFeatured(req.body.featured);
    if (req.body?.custom_css !== undefined) {
      if (String(req.body.custom_css || "").length > MAX_CSS)
        return res
          .status(400)
          .json({
            ok: false,
            error: `Custom CSS is limited to ${MAX_CSS} characters`,
          });
      next.custom_css = cleanCss(req.body.custom_css);
    }
    await db.query(
      `INSERT INTO site_design_settings (setting_key, draft_json, published_json, published_at)
       VALUES ($1, $2::jsonb, $2::jsonb, NOW())
       ON CONFLICT (setting_key) DO UPDATE
         SET draft_json = EXCLUDED.draft_json, published_json = EXCLUDED.published_json,
             published_at = NOW(), updated_at = NOW()`,
      [KEY, JSON.stringify(next)],
    );
    res.json({ ok: true, options: next });
  } catch (e) {
    console.error("[siteOptions] save failed:", e);
    res.status(500).json({ ok: false, error: "Unable to save site options" });
  }
});

router.cleanCss = cleanCss; // for tests
module.exports = router;
