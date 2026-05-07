// server-api/routes/bunnyStream.js
// Creates Bunny Stream videos and returns TUS upload headers.
// Mounted in server.js with: app.use("/api", bunnyStreamRouter)
// Final endpoint: POST /api/bunny/stream/presign

const express = require("express");
const crypto = require("crypto");
const fetch = require("node-fetch"); // keep node-fetch@2 for CommonJS compatibility

const router = express.Router();

const authenticate = require("../middleware/authenticate");
const db = require("../db");

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

/* -------------------- Bunny Stream Migration Helpers -------------------- */

const BUNNY_STORAGE_TOKEN_ENABLED =
  String(process.env.BUNNY_TOKEN_AUTH_ENABLED || "").toLowerCase() === "true";
const BUNNY_STORAGE_TOKEN_KEY = process.env.BUNNY_TOKEN_AUTH_KEY || "";
const BUNNY_STORAGE_CDN_BASE = String(process.env.BUNNY_CDN_BASE_URL || "")
  .trim()
  .replace(/\/+$/g, "");

function base64UrlNoPad(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\n/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function dirnamePath(p) {
  const clean = String(p || "/");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx + 1);
}

function isHttpUrl(v) {
  return /^https?:\/\//i.test(String(v || ""));
}

function maybeResignBunnyStorageUrl(inputUrl) {
  const raw = String(inputUrl || "").trim();
  if (!raw || !isHttpUrl(raw)) return raw;
  if (!BUNNY_STORAGE_TOKEN_ENABLED || !BUNNY_STORAGE_TOKEN_KEY) return raw;

  try {
    const url = new URL(raw);
    const base = BUNNY_STORAGE_CDN_BASE
      ? new URL(BUNNY_STORAGE_CDN_BASE)
      : null;

    // Only sign URLs for your configured Bunny Storage CDN hostname.
    if (base && url.hostname !== base.hostname) return raw;

    // Remove stale/old token params before creating a fresh signed URL for Bunny's fetcher.
    url.searchParams.delete("token");
    url.searchParams.delete("expires");
    url.searchParams.delete("token_path");

    const pathname = url.pathname || "/";
    const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    const tokenPath = dirnamePath(pathname);
    const paramData = `token_path=${tokenPath}`;
    const hashable = `${BUNNY_STORAGE_TOKEN_KEY}${pathname}${expires}${paramData}`;
    const token = base64UrlNoPad(
      crypto.createHash("sha256").update(hashable).digest(),
    );

    url.searchParams.set("token", token);
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("token_path", tokenPath);
    return url.toString();
  } catch {
    return raw;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bunnyJson(url, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      AccessKey: API_KEY,
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const detail = data?.message || data?.raw || text || resp.statusText;
    throw new Error(`Bunny Stream error ${resp.status}: ${detail}`);
  }

  return data;
}

async function findBunnyVideoByExactTitle(title) {
  const search = encodeURIComponent(title);
  const listUrl = `https://video.bunnycdn.com/library/${LIB_ID}/videos?page=1&itemsPerPage=100&search=${search}&orderBy=date`;
  const data = await bunnyJson(listUrl, { method: "GET" });
  const items = Array.isArray(data?.items) ? data.items : [];
  return (
    items.find((v) => String(v?.title || "") === String(title)) ||
    items.find((v) => String(v?.title || "").includes(String(title))) ||
    null
  );
}

async function updateBunnyVideoTitle(videoId, title) {
  try {
    await bunnyJson(
      `https://video.bunnycdn.com/library/${LIB_ID}/videos/${videoId}`,
      {
        method: "POST",
        body: JSON.stringify({ title: title || "Untitled" }),
      },
    );
  } catch (e) {
    console.warn(
      "[bunnyStream] Could not restore Bunny video title:",
      e.message,
    );
  }
}

function safeStreamStatusFromBunny(v) {
  // Bunny status values are numeric. During URL fetch/import this usually starts as processing.
  if (!v) return "processing";
  const progress = Number(v.encodeProgress || 0);
  const status = Number(v.status);
  if (progress >= 100 || status === 4) return "ready";
  if (status === 5 || status === 6 || status === 7 || status === 8)
    return "error";
  return "processing";
}

async function updateLocalVideoAfterBunnyMigration({
  localVideo,
  bunnyVideo,
  sourceUrl,
}) {
  const bunnyVideoId =
    bunnyVideo?.guid || bunnyVideo?.videoId || bunnyVideo?.id;
  if (!bunnyVideoId)
    throw new Error("Bunny video GUID was not found after fetch.");

  const urls = buildPlaybackUrls(bunnyVideoId);
  const status = safeStreamStatusFromBunny(bunnyVideo);
  const progress = safeProgressFromBunny(bunnyVideo);

  const metaPatch = {
    bunny_stream_migration: {
      migrated_at: new Date().toISOString(),
      source_url: sourceUrl,
      bunny_status: bunnyVideo?.status ?? null,
      encode_progress: progress,
      bunny_thumbnail_url: urls.thumbnailUrl,
    },
  };

  const updateSql = `
    UPDATE videos
       SET provider = 'bunny_stream',
           provider_key = $2,
           bunny_video_id = $2,
           bunny_library_id = $3,
           playback_url = $4,
           embed_url = $5,
           video_url = $4,
           processing_status = $6,
           metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $7::jsonb,
           updated_at = NOW()
     WHERE id = $1
     RETURNING *
  `;

  const result = await db.query(updateSql, [
    localVideo.id,
    String(bunnyVideoId),
    String(LIB_ID),
    urls.playbackUrl,
    urls.embedUrl,
    status,
    JSON.stringify(metaPatch),
  ]);

  return result.rows[0];
}

async function migrateOneLocalVideo(localVideo) {
  if (!LIB_ID || !API_KEY) {
    throw new Error("Bunny Stream env not configured.");
  }

  if (!localVideo) throw new Error("Video not found.");

  if (localVideo.provider === "bunny_stream" && localVideo.bunny_video_id) {
    return { skipped: true, reason: "already_migrated", video: localVideo };
  }

  const source = String(localVideo.video_url || "").trim();
  if (!source || !isHttpUrl(source)) {
    throw new Error(
      "This video does not have a public HTTP/HTTPS source URL to migrate.",
    );
  }

  const sourceUrl = maybeResignBunnyStorageUrl(source);
  const originalTitle =
    String(localVideo.title || "Untitled").trim() || "Untitled";
  const uniqueTitle = `${originalTitle} [NLM-MIGRATE-${localVideo.id}-${Date.now()}]`;

  await bunnyJson(`https://video.bunnycdn.com/library/${LIB_ID}/videos/fetch`, {
    method: "POST",
    body: JSON.stringify({
      url: sourceUrl,
      title: uniqueTitle,
      headers: {},
    }),
  });

  let bunnyVideo = null;
  for (let i = 0; i < 10; i += 1) {
    bunnyVideo = await findBunnyVideoByExactTitle(uniqueTitle);
    if (bunnyVideo?.guid) break;
    await sleep(800);
  }

  if (!bunnyVideo?.guid) {
    throw new Error(
      "Bunny started the URL fetch, but the new video ID was not found yet. Wait one minute, then try again.",
    );
  }

  await updateBunnyVideoTitle(bunnyVideo.guid, originalTitle);
  const updated = await updateLocalVideoAfterBunnyMigration({
    localVideo,
    bunnyVideo,
    sourceUrl,
  });

  return { skipped: false, video: updated, bunnyVideoId: bunnyVideo.guid };
}

/**
 * POST /api/bunny/stream/migrate/:id
 * Migrates one existing DB video URL into Bunny Stream using Bunny URL Fetch.
 */
router.post(
  "/bunny/stream/migrate/:id",
  authenticate,
  allowUploadRoles,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, message: "Invalid video ID" });
      }

      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        id,
      ]);
      if (q.rowCount === 0) {
        return res.status(404).json({ ok: false, message: "Video not found" });
      }

      const result = await migrateOneLocalVideo(q.rows[0]);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[bunnyStream] migrate one error:", err);
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Migration failed" });
    }
  },
);

/**
 * POST /api/bunny/stream/migrate-bulk
 * Body: { ids: number[] }
 * Sequential migration keeps API usage predictable and preserves records.
 */
router.post(
  "/bunny/stream/migrate-bulk",
  authenticate,
  allowUploadRoles,
  async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No video IDs provided" });
    }

    const results = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        results.push({ id: rawId, ok: false, message: "Invalid video ID" });
        continue;
      }

      try {
        const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
          id,
        ]);
        if (q.rowCount === 0) {
          results.push({ id, ok: false, message: "Video not found" });
          continue;
        }

        const migrated = await migrateOneLocalVideo(q.rows[0]);
        results.push({
          id,
          ok: true,
          skipped: !!migrated.skipped,
          bunnyVideoId:
            migrated.bunnyVideoId || migrated.video?.bunny_video_id || null,
        });
      } catch (err) {
        results.push({
          id,
          ok: false,
          message: err?.message || "Migration failed",
        });
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return res.json({ ok: failed === 0, migrated: ok, failed, results });
  },
);

async function getBunnyVideoById(videoId) {
  if (!videoId) return null;
  try {
    return await bunnyJson(
      `https://video.bunnycdn.com/library/${LIB_ID}/videos/${videoId}`,
      { method: "GET" },
    );
  } catch (e) {
    console.warn(
      "[bunnyStream] Could not fetch Bunny video status:",
      e.message,
    );
    return null;
  }
}

function safeProgressFromBunny(v) {
  const progress = Number(v?.encodeProgress ?? v?.encode_progress ?? 0);
  if (!Number.isFinite(progress)) return 0;
  return Math.max(0, Math.min(100, Math.round(progress)));
}

async function syncLocalVideoBunnyStatus(localVideo) {
  if (!localVideo) throw new Error("Video not found.");

  if (
    String(localVideo.provider || "").toLowerCase() !== "bunny_stream" ||
    !localVideo.bunny_video_id
  ) {
    return {
      skipped: true,
      reason: "not_bunny_stream",
      video: localVideo,
      progress: 0,
      processing_status: localVideo.processing_status || null,
    };
  }

  const bunnyVideo = await getBunnyVideoById(localVideo.bunny_video_id);
  if (!bunnyVideo) {
    return {
      skipped: true,
      reason: "bunny_status_unavailable",
      video: localVideo,
      progress: Number(
        localVideo.metadata?.bunny_stream_migration?.encode_progress || 0,
      ),
      processing_status: localVideo.processing_status || "processing",
    };
  }

  const progress = safeProgressFromBunny(bunnyVideo);
  const processingStatus = safeStreamStatusFromBunny(bunnyVideo);
  const urls = buildPlaybackUrls(localVideo.bunny_video_id);

  const metaPatch = {
    bunny_stream_migration: {
      ...(localVideo.metadata?.bunny_stream_migration || {}),
      synced_at: new Date().toISOString(),
      bunny_status: bunnyVideo?.status ?? null,
      encode_progress: progress,
      bunny_thumbnail_url: urls.thumbnailUrl,
    },
  };

  const result = await db.query(
    `
      UPDATE videos
         SET processing_status = $2,
             playback_url = COALESCE(NULLIF(playback_url, ''), $3),
             embed_url = COALESCE(NULLIF(embed_url, ''), $4),
             video_url = COALESCE(NULLIF(playback_url, ''), NULLIF(video_url, ''), $3),
             metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $5::jsonb,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *
    `,
    [
      localVideo.id,
      processingStatus,
      urls.playbackUrl,
      urls.embedUrl,
      JSON.stringify(metaPatch),
    ],
  );

  return {
    skipped: false,
    video: result.rows[0],
    progress,
    processing_status: processingStatus,
    bunny_status: bunnyVideo?.status ?? null,
  };
}

/**
 * GET /api/bunny/stream/status/:id
 * Syncs one local DB video with Bunny Stream processing progress.
 */
router.get(
  "/bunny/stream/status/:id",
  authenticate,
  allowUploadRoles,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ ok: false, message: "Invalid video ID" });
      }

      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        id,
      ]);
      if (q.rowCount === 0) {
        return res.status(404).json({ ok: false, message: "Video not found" });
      }

      const result = await syncLocalVideoBunnyStatus(q.rows[0]);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[bunnyStream] status sync error:", err);
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Status sync failed" });
    }
  },
);

/**
 * POST /api/bunny/stream/status-bulk
 * Body: { ids: number[] }
 * Syncs Bunny Stream processing progress for multiple local videos.
 */
router.post(
  "/bunny/stream/status-bulk",
  authenticate,
  allowUploadRoles,
  async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) {
      return res
        .status(400)
        .json({ ok: false, message: "No video IDs provided" });
    }

    const results = [];
    for (const rawId of ids) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) {
        results.push({ id: rawId, ok: false, message: "Invalid video ID" });
        continue;
      }

      try {
        const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
          id,
        ]);
        if (q.rowCount === 0) {
          results.push({ id, ok: false, message: "Video not found" });
          continue;
        }

        const synced = await syncLocalVideoBunnyStatus(q.rows[0]);
        results.push({
          id,
          ok: true,
          progress: synced.progress,
          processing_status: synced.processing_status,
          video: synced.video,
          skipped: !!synced.skipped,
          reason: synced.reason || null,
        });
      } catch (err) {
        results.push({
          id,
          ok: false,
          message: err?.message || "Status sync failed",
        });
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return res.json({ ok: failed === 0, synced: ok, failed, results });
  },
);

module.exports = router;
