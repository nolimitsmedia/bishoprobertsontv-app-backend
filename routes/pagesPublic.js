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
        content_html,
        content_json,
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
