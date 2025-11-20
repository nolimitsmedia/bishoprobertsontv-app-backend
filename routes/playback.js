const express = require("express");
const router = express.Router();
const { verifyHls } = require("../lib/tokens");

const HLS_CDN_BASE =
  process.env.LIVEPEER_HLS_CDN_BASE || "https://livepeercdn.com/hls";

/**
 * GET /play/hls/:playbackId/index.m3u8?exp=...&sig=...
 * - Verifies our HMAC and 302-redirects to Livepeer CDN.
 * - Soft-gating: protects the master manifest. (For full segment protection, enable
 *   Livepeer JWT playback policy later; this is enough for MVP.)
 */
router.get("/hls/:pid/index.m3u8", async (req, res) => {
  try {
    const { pid } = req.params;
    const { exp, sig } = req.query;
    if (!verifyHls(pid, exp, sig))
      return res.status(403).send("Invalid or expired token");

    const target = `${HLS_CDN_BASE}/${pid}/index.m3u8`;
    res.setHeader("Cache-Control", "private, max-age=0, no-store");
    return res.redirect(302, target);
  } catch (e) {
    console.error("[GET /play/hls] error", e);
    return res.status(500).send("Playback error");
  }
});

module.exports = router;
