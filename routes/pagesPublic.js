// server-api/routes/pagesPublic.js
const express = require("express");
const router = express.Router();
const db = require("../db");

// Public page by slug (published only)
// Example: /api/pages/home or /api/pages/about
router.get("/:slug", async (req, res) => {
  try {
    // ✅ prevent stale responses (ETag/304 issues)
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    // Phase 7-2: if this page's scheduled publish time has passed (for example
    // while the server was asleep), publish it now so the visitor sees it.
    try {
      const due = await db.query(
        `SELECT 1 FROM pages
          WHERE slug = $1
            AND (to_jsonb(pages) ->> 'publish_at') IS NOT NULL
            AND (to_jsonb(pages) ->> 'publish_at')::timestamptz <= NOW()
          LIMIT 1`,
        [String(req.params.slug || "")],
      );
      if (due.rows.length) await require("./adminPages").runDueSchedules();
    } catch (e) {
      console.error(
        "[pagesPublic] scheduled publish check failed:",
        e?.message || e,
      );
    }
    res.setHeader("Surrogate-Control", "no-store");

    const slug = String(req.params.slug || "")
      .trim()
      .toLowerCase();
    if (!slug)
      return res.status(400).json({ ok: false, error: "Missing slug" });

    // Select only what the frontend needs.
    const { rows } = await db.query(
      `
      SELECT
        id,
        title,
        slug,
        status,
        excerpt,
        hero_image_url,
        -- Phase 6: read through to_jsonb so this works before the SEO migration runs
        to_jsonb(pages) ->> 'seo_title' AS seo_title,
        to_jsonb(pages) ->> 'seo_description' AS seo_description,
        to_jsonb(pages) ->> 'seo_image_url' AS seo_image_url,
        COALESCE((to_jsonb(pages) ->> 'seo_noindex')::boolean, FALSE) AS seo_noindex,
        COALESCE(published_html, content_html) AS content_html,
        COALESCE(published_json, content_json) AS content_json,
        updated_at,
        published_at
      FROM pages
      WHERE slug=$1
        AND status='published'
      LIMIT 1
      `,
      [slug],
    );

    if (!rows.length) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    return res.json({ ok: true, page: rows[0] });
  } catch (e) {
    console.error("[pagesPublic] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
