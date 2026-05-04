// server-api/routes/bunnyStream.js
// Express router that creates a Bunny Stream video and returns TUS presigned headers
// ENV required: BUNNY_STREAM_LIBRARY_ID, BUNNY_STREAM_API_KEY

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // npm i node-fetch@2
const router = express.Router();

const LIB_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const API_KEY = process.env.BUNNY_STREAM_API_KEY;

if (!LIB_ID || !API_KEY) {
  console.warn(
    "[bunnyStream] Missing env BUNNY_STREAM_LIBRARY_ID and/or BUNNY_STREAM_API_KEY"
  );
}

/**
 * Create a stream video in Bunny and return presigned TUS headers for direct browser upload.
 * POST /api/bunny/stream/presign
 * Body: { title: string, expiresInSec?: number }
 * Resp: { ok, videoId, libraryId, signature, expires, tusEndpoint, embedUrl }
 */
router.post("/bunny/stream/presign", async (req, res) => {
  try {
    const title = String(req.body?.title || "Untitled");
    const expiresInSec = Math.max(
      300,
      Math.min(60 * 60 * 24, Number(req.body?.expiresInSec || 60 * 60))
    ); // default 1h, min 5m, max 24h

    if (!LIB_ID || !API_KEY) {
      return res
        .status(500)
        .json({ ok: false, message: "Bunny Stream env not configured." });
    }

    // 1) Create a Bunny Stream video object
    const createUrl = `https://video.bunnycdn.com/library/${LIB_ID}/videos`;
    const createResp = await fetch(createUrl, {
      method: "POST",
      headers: {
        AccessKey: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
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
    const videoId = created?.guid || created?.videoId || created?.id; // Bunny returns "guid"
    if (!videoId) {
      return res
        .status(500)
        .json({ ok: false, message: "Bunny response missing videoId/guid" });
    }

    // 2) Build presigned TUS headers (sha256(library_id + api_key + expiration_time + video_id))
    const expires = Math.floor(Date.now() / 1000) + expiresInSec;
    const signatureBase = `${LIB_ID}${API_KEY}${expires}${videoId}`;
    const signature = crypto
      .createHash("sha256")
      .update(signatureBase)
      .digest("hex");

    // 3) Return data to the client
    const tusEndpoint = "https://video.bunnycdn.com/tusupload";
    const embedUrl = `https://iframe.mediadelivery.net/embed/${LIB_ID}/${videoId}`;

    res.json({
      ok: true,
      videoId,
      libraryId: Number(LIB_ID),
      signature,
      expires,
      tusEndpoint,
      embedUrl,
    });
  } catch (err) {
    console.error("[bunnyStream] presign error:", err);
    res
      .status(500)
      .json({ ok: false, message: err?.message || "Presign error" });
  }
});

module.exports = router;
