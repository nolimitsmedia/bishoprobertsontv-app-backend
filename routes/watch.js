const express = require("express");
const router = express.Router();
const db = require("../db");
const { signHls } = require("../lib/tokens");

let requireAuth;
try {
  ({ requireAuth } = require("../middleware/auth"));
} catch {}
let authenticate;
try {
  authenticate = require("../middleware/authenticate");
} catch {}
const baseAuth =
  (typeof requireAuth === "function" && requireAuth) ||
  authenticate ||
  ((_req, _res, next) => next());

const HLS_CDN_BASE =
  process.env.LIVEPEER_HLS_CDN_BASE || "https://livepeercdn.com/hls";

/* helpers */
function getUserId(req) {
  return req?.user?.id || req?.user?.user_id || req?.user?.uid || null;
}
async function hasActiveSub(userId) {
  if (!userId) return false;
  try {
    const { rows } = await db.query(
      "SELECT 1 FROM subscriptions WHERE user_id=$1 AND canceled_at IS NULL LIMIT 1",
      [userId]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}
function parsePlaybackIdFromUrl(url) {
  if (!url) return null;
  // matches https://livepeercdn.com/hls/<playbackId>/index.m3u8
  const m = url.match(/\/hls\/([^/]+)\/index\.m3u8/i);
  return m ? m[1] : null;
}

/**
 * GET /watch/:id
 * Returns entitled playback info for VOD (and can be extended for live).
 * Response:
 *  { id, title, is_premium, hls_url, tokenized_hls_url, subtitles: [], thumbs: {...} }
 */
router.get("/:id", baseAuth, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ message: "Invalid id" });

    const q = await db.query("SELECT * FROM videos WHERE id=$1 LIMIT 1", [id]);
    const row = q.rows[0];
    if (!row) return res.status(404).json({ message: "Not found" });

    const premium = !!row.is_premium;
    const userId = getUserId(req);
    if (premium && !(await hasActiveSub(userId))) {
      return res.status(402).json({ message: "Subscription required" });
    }

    let directHls = row.video_url || null;
    let pid = parsePlaybackIdFromUrl(directHls);

    let tokenizedUrl = directHls;
    if (pid) {
      // sign a short-lived URL to our gateway
      const { exp, sig } = signHls(pid, 3600, userId);
      const base =
        (req.headers["x-forwarded-proto"] || req.protocol || "https") +
        "://" +
        (req.headers["x-forwarded-host"] || req.headers.host);
      tokenizedUrl = `${base}/play/hls/${pid}/index.m3u8?exp=${exp}&sig=${encodeURIComponent(
        sig
      )}`;
    }

    return res.json({
      id: row.id,
      title: row.title || "",
      is_premium: premium,
      hls_url: directHls, // original (for debugging)
      tokenized_hls_url: tokenizedUrl, // player should use this one
      subtitles: [], // extend when you have captions
      thumbnails: { poster: row.thumbnail_url || null },
    });
  } catch (e) {
    console.error("[GET /watch/:id] error:", e);
    res.status(500).json({ message: "Failed to load playback" });
  }
});

module.exports = router;
