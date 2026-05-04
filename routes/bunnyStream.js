// server-api/routes/bunnyStream.js
// Creates Bunny Stream videos and returns TUS upload headers.
// Mounted in server.js with: app.use("/api", bunnyStreamRouter)
// Final endpoint: POST /api/bunny/stream/presign

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // keep node-fetch@2 for CommonJS compatibility

const router = express.Router();

const authenticate = require("../middleware/authenticate");

const LIB_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim();
const API_KEY = String(process.env.BUNNY_STREAM_API_KEY || "").trim();

// Bunny Stream HLS CDN host.
// If Bunny gives you a custom Stream CDN hostname, set:
// BUNNY_STREAM_CDN_HOST=your-stream-host.b-cdn.net
const STREAM_CDN_HOST = String(
  process.env.BUNNY_STREAM_CDN_HOST ||
    process.env.BUNNY_STREAM_PULL_ZONE_URL ||
    `vz-${LIB_ID}.b-cdn.net`,
)
  .trim()
  .replace(/^https?:\/\//i, "")
  .replace(/\/+$/g, "");

if (!LIB_ID || !API_KEY) {
  console.warn(
    "[bunnyStream] Missing env BUNNY_STREAM_LIBRARY_ID and/or BUNNY_STREAM_API_KEY",
  );
}

function allowUploadRoles(req, res, next) {
  const role = String(req.user?.role || "user").toLowerCase();
  if (
    role === "user" ||
    role === "admin" ||
    role === "creator" ||
    role === "owner"
  ) {
    return next();
  }
  return res
    .status(403)
    .json({ ok: false, message: "Forbidden: role not allowed" });
}

function buildPlaybackUrls(videoId) {
  const hlsUrl = STREAM_CDN_HOST
    ? `https://${STREAM_CDN_HOST}/${videoId}/playlist.m3u8`
    : "";
  const thumbnailUrl = STREAM_CDN_HOST
    ? `https://${STREAM_CDN_HOST}/${videoId}/thumbnail.jpg`
    : "";
  const embedUrl = `https://iframe.mediadelivery.net/embed/${LIB_ID}/${videoId}`;

  return {
    hlsUrl,
    playbackUrl: hlsUrl,
    thumbnailUrl,
    embedUrl,
  };
}

/**
 * Create a Bunny Stream video and return presigned TUS headers for direct browser upload.
 *
 * POST /api/bunny/stream/presign
 * Body: { title, filename, contentType, sizeBytes, expiresInSec }
 */
router.post(
  "/bunny/stream/presign",
  authenticate,
  allowUploadRoles,
  async (req, res) => {
    try {
      const title = String(
        req.body?.title || req.body?.filename || "Untitled",
      ).trim();
      const expiresInSec = Math.max(
        300,
        Math.min(60 * 60 * 24, Number(req.body?.expiresInSec || 60 * 60)),
      );

      if (!LIB_ID || !API_KEY) {
        return res.status(500).json({
          ok: false,
          message: "Bunny Stream env not configured.",
        });
      }

      const createUrl = `https://video.bunnycdn.com/library/${LIB_ID}/videos`;
      const createResp = await fetch(createUrl, {
        method: "POST",
        headers: {
          AccessKey: API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title: title || "Untitled" }),
      });

      if (!createResp.ok) {
        const text = await createResp.text();
        console.error("[bunnyStream] create video failed:", text);
        return res.status(createResp.status).json({
          ok: false,
          message: "Bunny create video failed",
          detail: text,
        });
      }

      const created = await createResp.json();
      const videoId = created?.guid || created?.videoId || created?.id;
      if (!videoId) {
        return res.status(500).json({
          ok: false,
          message: "Bunny response missing videoId/guid",
        });
      }

      // Bunny TUS signature:
      // sha256(library_id + api_key + expiration_time + video_id)
      const expires = Math.floor(Date.now() / 1000) + expiresInSec;
      const signature = crypto
        .createHash("sha256")
        .update(`${LIB_ID}${API_KEY}${expires}${videoId}`)
        .digest("hex");

      const urls = buildPlaybackUrls(videoId);

      return res.json({
        ok: true,
        videoId,
        libraryId: String(LIB_ID),
        signature,
        expires,
        tusEndpoint: "https://video.bunnycdn.com/tusupload",

        // Save these into your videos table.
        provider: "bunny_stream",
        providerKey: videoId,
        bunny_video_id: videoId,
        bunny_library_id: String(LIB_ID),
        embedUrl: urls.embedUrl,
        hlsUrl: urls.hlsUrl,
        playbackUrl: urls.playbackUrl,
        thumbnailUrl: urls.thumbnailUrl,
      });
    } catch (err) {
      console.error("[bunnyStream] presign error:", err);
      return res.status(500).json({
        ok: false,
        message: err?.message || "Presign error",
      });
    }
  },
);

module.exports = router;
