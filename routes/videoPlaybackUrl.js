const express = require("express");
const router = express.Router();
const db = require("../db");
const { requireAuth } = require("../middleware/auth");
const wasabi = require("../services/importer/providers/importWasabi");

// GET /api/videos/:id/playback-url
router.get("/:id/playback-url", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid id" });

    const vr = await db.query(
      `SELECT id, title, video_url, visibility
       FROM videos
       WHERE id=$1
       LIMIT 1`,
      [id],
    );

    if (!vr.rows[0])
      return res.status(404).json({ ok: false, message: "Video not found" });

    const v = vr.rows[0];
    const visibility = String(v.visibility || "private").toLowerCase();

    // If private, enforce auth (you can tighten this later with roles/subscription)
    if (visibility === "private") {
      // requireAuth is middleware style; call it inline to avoid creating a second route
      return requireAuth(req, res, async () => {
        const out = await resolvePlaybackUrl(v);
        return res.json(out);
      });
    }

    // public/unlisted
    const out = await resolvePlaybackUrl(v);
    return res.json(out);
  } catch (e) {
    console.error("[playback-url]", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

async function resolvePlaybackUrl(videoRow) {
  // Get Wasabi connection settings
  // (We reuse provider's internal fetch via signKey / extractKeyFromUrl)
  // Access mode controls whether we return direct or signed
  const cfg = await (async () => {
    // piggy-back on provider internals by calling makeRemoteUrl for direct URL base
    // We still need access_mode + ttl; easiest is to read active config here again:
    const r = await db.query(
      `SELECT meta
       FROM storage_connections
       WHERE provider='wasabi' AND is_active=TRUE
       LIMIT 1`,
    );
    const meta = r.rows?.[0]?.meta || {};
    return {
      endpoint: meta.endpoint,
      bucket: meta.bucket,
      access_mode: String(meta.access_mode || "auto"),
      ttl: Number(meta.signed_url_ttl_seconds || 3600),
    };
  })();

  const visibility = String(videoRow.visibility || "private").toLowerCase();

  // Decide signed vs direct
  const forceSigned =
    cfg.access_mode === "private" ||
    (cfg.access_mode === "auto" && visibility === "private");

  if (!forceSigned) {
    return { ok: true, url: videoRow.video_url, signed: false, visibility };
  }

  // Only sign if this looks like a Wasabi direct URL we can parse
  const key = wasabi.extractKeyFromUrl({
    endpoint: cfg.endpoint,
    bucket: cfg.bucket,
    url: videoRow.video_url,
  });

  if (!key) {
    // Fallback: if it isn't a Wasabi URL, just return it (or you can error)
    return {
      ok: true,
      url: videoRow.video_url,
      signed: false,
      visibility,
      note: "Could not derive key to sign",
    };
  }

  const signedUrl = await wasabi.signKey(key, { expiresInSeconds: cfg.ttl });
  return {
    ok: true,
    url: signedUrl,
    signed: true,
    visibility,
    ttl_seconds: cfg.ttl,
  };
}

module.exports = router;
