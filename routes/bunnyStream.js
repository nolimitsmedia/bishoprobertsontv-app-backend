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

// let (not const): a Bunny connection saved on the Cloud Storage page replaces
// these at run time (lib/bunnyConfig.js › refreshBunnyConfig below).
let LIB_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim();
let API_KEY = String(process.env.BUNNY_STREAM_API_KEY || "").trim();

// Bunny Stream HLS CDN host.
// If Bunny gives you a custom Stream CDN hostname, set:
// BUNNY_STREAM_CDN_HOST=your-stream-host.b-cdn.net
let STREAM_CDN_HOST = String(
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
  // Do not expose/save the raw Bunny Stream CDN thumbnail URL here.
  // On some Bunny Stream libraries, direct thumbnail URLs like
  // https://vz-<library>.b-cdn.net/<videoId>/thumbnail.jpg can show
  // "Domain suspended or not configured" when opened directly.
  // The app should use its default thumbnail until an admin uploads a custom
  // thumbnail through Bunny Storage / image upload.
  const thumbnailUrl = "";
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
        thumbnailUrl: urls.thumbnailUrl || null,
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

/* ------------------------------------------------------------------
 * Retry a FAILED migration: Bunny Stream could not encode the copy (status
 * error / failed), so the video shows "Processing video" forever. Remove the
 * failed copy and have Bunny fetch the original file again.
 * ------------------------------------------------------------------ */
// Staff only (website / content / video uploader), unlike allowUploadRoles,
// which also lets ordinary members through.
const { requireArea } = require("../lib/teamAccess");
const retryAccess = requireArea("website", "content", "video_upload");

function isFailedStreamVideo(v) {
  const st = String(v?.processing_status || "").toLowerCase();
  return (
    String(v?.provider || "").toLowerCase() === "bunny_stream" &&
    (st === "error" || st === "failed")
  );
}
function migrationSourceOf(v) {
  let md = v?.metadata || {};
  if (typeof md === "string") {
    try {
      md = JSON.parse(md);
    } catch {
      md = {};
    }
  }
  const m = md.bunny_stream_migration || {};
  return String(m.source_url || m.sourceUrl || "").trim();
}

// Sign a storage address with a chosen path form (Bunny token auth v2).
function signStorageUrl(cleanUrl, hashPath) {
  const url = new URL(cleanUrl);
  const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
  const tokenPath = dirnamePath(hashPath);
  const hashable = `${BUNNY_STORAGE_TOKEN_KEY}${hashPath}${expires}token_path=${tokenPath}`;
  const token = base64UrlNoPad(
    crypto.createHash("sha256").update(hashable).digest(),
  );
  url.searchParams.set("token", token);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("token_path", tokenPath);
  return url.toString();
}

// Can this address actually be downloaded? (first byte only)
async function probeDownload(url, extraHeaders = {}) {
  try {
    const r = await fetch(url, {
      method: "GET",
      headers: { Range: "bytes=0-0", ...extraHeaders },
      timeout: 15000,
      redirect: "follow",
    });
    try {
      r.body?.destroy?.();
    } catch {
      /* ignore */
    }
    return r.status;
  } catch (e) {
    return `error (${e?.code || e?.message || "network"})`;
  }
}

// Find an address of the original that Bunny Storage really serves. Tries the
// token signed over the encoded path and over the plain path (file names with
// curly quotes / spaces differ), unsigned, and the saved address.
async function pickDownloadableSource(original) {
  const clean = (() => {
    try {
      const u = new URL(original);
      ["token", "expires", "token_path"].forEach((k) =>
        u.searchParams.delete(k),
      );
      return u.toString();
    } catch {
      return original;
    }
  })();
  const candidates = [];
  if (BUNNY_STORAGE_TOKEN_ENABLED && BUNNY_STORAGE_TOKEN_KEY) {
    const encodedPath = new URL(clean).pathname || "/";
    let plainPath = encodedPath;
    try {
      plainPath = decodeURIComponent(encodedPath);
    } catch {
      /* keep encoded */
    }
    candidates.push({
      how: "signed (encoded path)",
      url: signStorageUrl(clean, encodedPath),
    });
    if (plainPath !== encodedPath)
      candidates.push({
        how: "signed (plain path)",
        url: signStorageUrl(clean, plainPath),
      });
  }
  candidates.push({ how: "unsigned", url: clean });
  if (original !== clean)
    candidates.push({ how: "saved address", url: original });
  // Hotlink protection ("Allowed Referrers") also answers 403 to requests that
  // don't come from the website: try every form as coming from the site too.
  const site = String(
    process.env.PUBLIC_SITE_URL ||
      "https://nolimitsmedia.github.io/bishoprobertsontv-app/",
  ).trim();
  const siteOrigin = (() => {
    try {
      return new URL(site).origin + "/";
    } catch {
      return "";
    }
  })();
  const tried = [];
  for (const c of candidates) {
    const status = await probeDownload(c.url);
    tried.push(`${c.how}: ${status}`);
    if (status === 200 || status === 206)
      return { ok: true, url: c.url, how: c.how, headers: {}, tried };
  }
  if (siteOrigin) {
    for (const c of candidates) {
      const headers = { Referer: siteOrigin };
      const status = await probeDownload(c.url, headers);
      tried.push(`${c.how} from the website: ${status}`);
      if (status === 200 || status === 206)
        return {
          ok: true,
          url: c.url,
          how: `${c.how} (from the website)`,
          headers,
          tried,
        };
    }
  }
  let host = "";
  try {
    host = new URL(clean).hostname;
  } catch {
    /* ignore */
  }
  const signing =
    BUNNY_STORAGE_TOKEN_ENABLED && BUNNY_STORAGE_TOKEN_KEY
      ? "on"
      : "OFF (BUNNY_TOKEN_AUTH_ENABLED=true and BUNNY_TOKEN_AUTH_KEY are not both set on the server)";
  return { ok: false, tried, host, signing };
}

async function retryFailedMigration(localVideo) {
  if (!LIB_ID || !API_KEY) throw new Error("Bunny Stream env not configured.");
  if (!localVideo) throw new Error("Video not found.");
  if (!isFailedStreamVideo(localVideo)) {
    return { skipped: true, reason: "not_failed", video: localVideo };
  }
  const original = migrationSourceOf(localVideo);
  if (!original || !isHttpUrl(original)) {
    throw new Error(
      'The original file of this video is not known. Use "Migrate to Bunny Storage" to play it from storage.',
    );
  }
  const oldId = String(localVideo.bunny_video_id || "").trim();

  // 0) The "original" is itself a Bunny Stream video (vz-….b-cdn.net): the
  //    message was uploaded straight to Bunny Stream and later "migrated" from
  //    its own Stream address, which Stream refuses (403). There is nothing to
  //    copy — link the message back to that first upload if it plays.
  // the address without any token, for messages
  const shownAddress = (() => {
    try {
      const u = new URL(original);
      ["token", "expires", "token_path"].forEach((k) =>
        u.searchParams.delete(k),
      );
      return u.toString().replace(/bcdn_token=[^/]*/i, "bcdn_token=…");
    } catch {
      return String(original).slice(0, 200);
    }
  })();
  const isStreamAddress = (() => {
    try {
      const h = new URL(original).hostname;
      return (
        /^vz-[a-z0-9-]+\.b-cdn\.net$/i.test(h) || /mediadelivery\.net$/i.test(h)
      );
    } catch {
      return false;
    }
  })();
  // the Bunny video id can be anywhere in the address (path, token part, query)
  const streamGuid = (() => {
    if (!isStreamAddress) return "";
    let all = String(original);
    try {
      all = decodeURIComponent(all);
    } catch {
      /* keep */
    }
    const m = all.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    return m ? m[0].toLowerCase() : "";
  })();
  if (isStreamAddress && !streamGuid) {
    throw new Error(
      `[retry v4] The saved "original" of this message is a Bunny Stream address without a video id (${shownAddress}). ` +
        `It was uploaded straight to Bunny Stream; there is no other copy to retry from — please upload the video file again. Nothing was changed.`,
    );
  }
  if (streamGuid) {
    const first =
      streamGuid !== oldId ? await getBunnyVideoById(streamGuid) : null;
    if (first && safeStreamStatusFromBunny(first) === "ready") {
      const updated = await updateLocalVideoAfterBunnyMigration({
        localVideo,
        bunnyVideo: first,
        sourceUrl: original,
      });
      if (oldId && oldId !== streamGuid) {
        try {
          await fetch(
            `https://video.bunnycdn.com/library/${LIB_ID}/videos/${oldId}`,
            {
              method: "DELETE",
              headers: { AccessKey: API_KEY, Accept: "application/json" },
            },
          );
        } catch {
          /* ignore */
        }
      }
      return {
        skipped: false,
        relinked: true,
        video: updated,
        bunnyVideoId: streamGuid,
        previousBunnyVideoId: oldId || null,
        source: "its first Bunny Stream upload",
      };
    }
    throw new Error(
      `[retry v4] This message was uploaded straight to Bunny Stream (video ${streamGuid}), and that upload ` +
        (first
          ? `cannot play either (Bunny status ${first.status}).`
          : `is no longer in the Bunny library.`) +
        ` There is no other copy of the file to retry from: please upload the video file again. Nothing was changed.`,
    );
  }

  // 1) make sure the original can really be downloaded — before changing anything
  const pick = await pickDownloadableSource(original);
  if (!pick.ok) {
    const err = new Error(
      `[retry v4] Bunny Storage (${pick.host || "storage"}) refuses the original file (${shownAddress}), so Bunny Stream cannot fetch it. ` +
        `Tried: ${pick.tried.join("; ")}. Token signing on the server: ${pick.signing}. ` +
        `Check that the file still exists in Bunny Storage, and that the token key on the server is this pull zone's ` +
        `"Token Authentication" key. Nothing was changed.`,
    );
    err.tried = pick.tried;
    throw err;
  }
  const sourceUrl = pick.url;

  // 2) remove the failed copy (ignore errors: it may already be gone)
  if (oldId) {
    try {
      await fetch(
        `https://video.bunnycdn.com/library/${LIB_ID}/videos/${oldId}`,
        {
          method: "DELETE",
          headers: { AccessKey: API_KEY, Accept: "application/json" },
        },
      );
    } catch {
      /* ignore */
    }
  }

  const originalTitle =
    String(localVideo.title || "Untitled").trim() || "Untitled";
  const uniqueTitle = `${originalTitle} [NLM-RETRY-${localVideo.id}-${Date.now()}]`;
  await bunnyJson(`https://video.bunnycdn.com/library/${LIB_ID}/videos/fetch`, {
    method: "POST",
    body: JSON.stringify({
      url: sourceUrl,
      title: uniqueTitle,
      headers: pick.headers || {},
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
      "Bunny started fetching the original again, but the new copy was not found yet. Wait a minute and refresh.",
    );
  }
  await updateBunnyVideoTitle(bunnyVideo.guid, originalTitle);
  const updated = await updateLocalVideoAfterBunnyMigration({
    localVideo,
    bunnyVideo,
    sourceUrl,
  });
  return {
    skipped: false,
    video: updated,
    bunnyVideoId: bunnyVideo.guid,
    previousBunnyVideoId: oldId || null,
    source: pick.how,
  };
}

/**
 * POST /api/bunny/stream/retry/:id   retry one failed migration
 */
router.post(
  "/bunny/stream/retry/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id))
        return res.status(400).json({ ok: false, message: "Invalid video ID" });
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        id,
      ]);
      if (q.rowCount === 0)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const result = await retryFailedMigration(q.rows[0]);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[bunnyStream] retry error:", err);
      return res
        .status(500)
        .json({
          ok: false,
          message: err?.message || "Retry failed",
          tried: err?.tried || undefined,
        });
    }
  },
);

/**
 * POST /api/bunny/stream/retry-failed   retry every failed migration (one at a time, up to 50)
 */
router.post(
  "/bunny/stream/retry-failed",
  authenticate,
  retryAccess,
  async (_req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM videos
        WHERE LOWER(COALESCE(provider, '')) = 'bunny_stream'
          AND LOWER(COALESCE(processing_status, '')) IN ('error', 'failed')
        ORDER BY id DESC LIMIT 50`,
      );
      const done = [];
      const failed = [];
      for (const row of rows) {
        try {
          const r = await retryFailedMigration(row);
          if (!r.skipped) done.push({ id: row.id, title: row.title });
        } catch (e) {
          failed.push({
            id: row.id,
            title: row.title,
            message: e?.message || "Retry failed",
          });
        }
      }
      return res.json({
        ok: true,
        found: rows.length,
        retried: done.length,
        failed,
      });
    } catch (err) {
      console.error("[bunnyStream] retry-failed error:", err);
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Retry failed" });
    }
  },
);

/**
 * POST /api/bunny/stream/migrate/:id
 * Migrates one existing DB video URL into Bunny Stream using Bunny URL Fetch.
 */
router.post(
  "/bunny/stream/migrate/:id",
  authenticate,
  retryAccess, // staff only (allowUploadRoles also let members through)
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
  retryAccess, // staff only (allowUploadRoles also let members through)
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

/* -------------------- Bunny Stream -> Bunny Storage Restore Helpers -------------------- */

function cleanStorageUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw);
    u.searchParams.delete("token");
    u.searchParams.delete("expires");
    u.searchParams.delete("token_path");
    return u.toString();
  } catch {
    return raw;
  }
}

function extractStorageProviderKey(url) {
  const raw = cleanStorageUrl(url);
  try {
    const u = new URL(raw);
    const configuredBase = BUNNY_STORAGE_CDN_BASE
      ? new URL(BUNNY_STORAGE_CDN_BASE)
      : null;

    if (configuredBase && u.hostname === configuredBase.hostname) {
      return decodeURIComponent((u.pathname || "/").replace(/^\/+/, ""));
    }

    return decodeURIComponent((u.pathname || "/").replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

function getRestoreStorageSource(localVideo) {
  const md = localVideo?.metadata || {};
  const migration = md?.bunny_stream_migration || {};
  const restore = md?.bunny_storage_restore || {};

  const candidates = [
    restore.storage_url,
    restore.source_url,
    migration.source_url,
    migration.sourceUrl,
    md.source_url,
    md.original_video_url,
    md.original_url,
  ];

  for (const candidate of candidates) {
    const clean = cleanStorageUrl(candidate);
    if (
      clean &&
      isHttpUrl(clean) &&
      !String(clean).includes("mediadelivery.net")
    ) {
      return clean;
    }
  }

  return "";
}

async function restoreOneBunnyStreamToStorage(localVideo) {
  if (!localVideo) throw new Error("Video not found.");

  const provider = String(localVideo.provider || "").toLowerCase();
  if (provider !== "bunny_stream" && !localVideo.bunny_video_id) {
    return { skipped: true, reason: "not_bunny_stream", video: localVideo };
  }

  const storageUrl = getRestoreStorageSource(localVideo);
  if (!storageUrl) {
    throw new Error(
      "No original Bunny Storage source URL was found for this Bunny Stream video. Restore is only possible when the original storage URL was saved during migration.",
    );
  }

  const cleanUrl = cleanStorageUrl(storageUrl);
  const providerKey = extractStorageProviderKey(cleanUrl);

  const metaPatch = {
    bunny_storage_restore: {
      restored_at: new Date().toISOString(),
      storage_url: cleanUrl,
      previous_provider: localVideo.provider || null,
      previous_bunny_video_id: localVideo.bunny_video_id || null,
      previous_bunny_library_id: localVideo.bunny_library_id || null,
      previous_playback_url: localVideo.playback_url || null,
      previous_embed_url: localVideo.embed_url || null,
    },
  };

  const result = await db.query(
    `
      UPDATE videos
         SET provider = 'bunny',
             provider_key = COALESCE(NULLIF($3, ''), provider_key),
             bunny_video_id = NULL,
             bunny_library_id = NULL,
             playback_url = NULL,
             embed_url = NULL,
             video_url = $2,
             processing_status = 'ready',
             metadata = COALESCE(metadata::jsonb, '{}'::jsonb) || $4::jsonb,
             updated_at = NOW()
       WHERE id = $1
       RETURNING *
    `,
    [localVideo.id, cleanUrl, providerKey, JSON.stringify(metaPatch)],
  );

  return { skipped: false, video: result.rows[0], storageUrl: cleanUrl };
}

/**
 * POST /api/bunny/stream/restore-storage/:id
 * Switches a Bunny Stream video record back to its saved Bunny Storage source URL.
 */
router.post(
  "/bunny/stream/restore-storage/:id",
  authenticate,
  retryAccess, // staff only (allowUploadRoles also let members through)
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

      const result = await restoreOneBunnyStreamToStorage(q.rows[0]);
      return res.json({ ok: true, ...result });
    } catch (err) {
      console.error("[bunnyStream] restore storage one error:", err);
      return res.status(500).json({
        ok: false,
        message: err?.message || "Restore to Bunny Storage failed",
      });
    }
  },
);

/**
 * POST /api/bunny/stream/restore-storage-bulk
 * Body: { ids: number[] }
 */
router.post(
  "/bunny/stream/restore-storage-bulk",
  authenticate,
  retryAccess, // staff only (allowUploadRoles also let members through)
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

        const restored = await restoreOneBunnyStreamToStorage(q.rows[0]);
        results.push({
          id,
          ok: true,
          skipped: !!restored.skipped,
          reason: restored.reason || null,
          storageUrl: restored.storageUrl || restored.video?.video_url || null,
        });
      } catch (err) {
        results.push({
          id,
          ok: false,
          message: err?.message || "Restore to Bunny Storage failed",
        });
      }
    }

    const ok = results.filter((r) => r.ok).length;
    const failed = results.length - ok;
    return res.json({ ok: failed === 0, restored: ok, failed, results });
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

/* ------------------------------------------------------------------
 * REPLACE VIDEO FILE — upload a new file into the SAME message, keeping its
 * title, details, comments, viewing history, My List / playlists and address.
 * The message keeps its current file until the new one is encoded and ready;
 * then it switches over and the old Bunny copy is removed.
 *   POST   /bunny/stream/replace/:id/start   → tus upload credentials
 *   GET    /bunny/stream/replace/:id/status  → uploading / processing / done / error
 *   DELETE /bunny/stream/replace/:id         → cancel
 * ------------------------------------------------------------------ */
function metaOf(v) {
  let md = v?.metadata || {};
  if (typeof md === "string") {
    try {
      md = JSON.parse(md);
    } catch {
      md = {};
    }
  }
  return md && typeof md === "object" ? md : {};
}

async function deleteBunnyVideoQuietly(guid) {
  if (!guid) return;
  try {
    await fetch(`https://video.bunnycdn.com/library/${LIB_ID}/videos/${guid}`, {
      method: "DELETE",
      headers: { AccessKey: API_KEY, Accept: "application/json" },
    });
  } catch {
    /* ignore */
  }
}

// Bunny's own explanation of a failed encode (video.transcodingMessages:
// level 2 = warning, 3 = error), e.g. "unsupported codec".
function bunnyReasons(bv) {
  const list = Array.isArray(bv?.transcodingMessages)
    ? bv.transcodingMessages
    : [];
  const out = list
    .filter(
      (m) =>
        Number(m?.level) >= 2 ||
        /error|fail|unsupported|invalid|corrupt|unable/i.test(
          String(m?.message || ""),
        ),
    )
    .map((m) => [m?.message, m?.value].filter(Boolean).join(": ").trim())
    .filter(Boolean);
  return [...new Set(out)].slice(0, 3);
}

// Check a pending replacement; switch the message over when Bunny is ready.
async function checkReplacement(row) {
  const md = metaOf(row);
  const pending = md.replace_pending;
  if (!pending?.bunny_video_id) return { state: "none" };
  const guid = String(pending.bunny_video_id);
  const bv = await getBunnyVideoById(guid);
  if (!bv) {
    await db.query(
      `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [
        row.id,
        JSON.stringify({
          replace_pending: {
            ...pending,
            status: "error",
            error: "The new upload is not in the Bunny library.",
          },
        }),
      ],
    );
    return {
      state: "error",
      message:
        "The new upload is not in the Bunny library. Please choose the file again.",
    };
  }
  const st = safeStreamStatusFromBunny(bv);
  if (st === "error") {
    await db.query(
      `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [
        row.id,
        JSON.stringify({
          replace_pending: {
            ...pending,
            status: "error",
            error: `Bunny could not encode the new file (status ${bv.status}).${bunnyReasons(bv).length ? ` Bunny says: ${bunnyReasons(bv).join(" · ")}` : ""}`,
          },
        }),
      ],
    );
    const why = bunnyReasons(bv);
    return {
      state: "error",
      reasons: why,
      message:
        `Bunny could not encode the new file (status ${bv.status}).` +
        (why.length ? ` Bunny says: ${why.join(" · ")}.` : "") +
        ` The message still uses its old file. Converting the file (e.g. HandBrake, “Fast 1080p30”, MP4) and uploading it usually fixes this.`,
    };
  }
  if (st !== "ready") {
    return {
      state:
        Number(bv.status) <= 1 && !Number(bv.encodeProgress)
          ? "uploading"
          : "processing",
      progress: Number(bv.encodeProgress || 0),
    };
  }

  // ready → switch the message to the new file
  const urls = buildPlaybackUrls(guid);
  const oldGuid = String(row.bunny_video_id || "").trim();
  const length = Math.round(Number(bv.length) || 0);
  const preview =
    md.preview_clip && typeof md.preview_clip === "object"
      ? { ...md.preview_clip, status: "outdated" }
      : undefined;
  const nextMeta = { ...md };
  delete nextMeta.replace_pending;
  if (nextMeta.bunny_stream_migration) {
    nextMeta.previous_migration = nextMeta.bunny_stream_migration;
    delete nextMeta.bunny_stream_migration;
  }
  if (preview) nextMeta.preview_clip = preview;
  nextMeta.file_replaced = {
    at: new Date().toISOString(),
    previous_bunny_video_id: oldGuid || null,
    previous_video_url: row.video_url || null,
    filename: pending.filename || null,
    // where the video now playing came from: upload | wasabi | cloud | repair | trim | migration
    source: pending.source || "upload",
    ...(pending.trim ? { trim: pending.trim } : {}),
  };
  // Trims are always cut from the full recording: remember the current trim
  // and the full length, so later trims use the same (full) timeline.
  if (pending.source === "trim" && pending.trim) {
    const full =
      Number(md.trim_state?.full_duration) ||
      Number(row.duration_seconds) ||
      null;
    const isRestore = pending.trim.restore === true;
    if (isRestore) delete nextMeta.trim_state;
    else
      nextMeta.trim_state = {
        start: pending.trim.start,
        end: pending.trim.end,
        full_duration: full,
        at: new Date().toISOString(),
      };
  } else {
    delete nextMeta.trim_state; // a new file: no trim any more
  }
  // A trim cut from Bunny's kept original: keep the FULL-length Bunny video
  // (not shown on the site) so the message can be trimmed again or restored.
  const trimmedFromBunny =
    pending.source === "trim" &&
    /bunny stream original|full-length/i.test(String(pending.trim?.from || ""));
  let keepOld = false;
  if (trimmedFromBunny) {
    if (!md.full_original?.bunny_video_id && oldGuid) {
      nextMeta.full_original = {
        bunny_video_id: oldGuid,
        kept_at: new Date().toISOString(),
      };
      keepOld = true;
    }
  } else if (md.full_original?.bunny_video_id && pending.source !== "trim") {
    // a brand-new file replaces the message: the kept full-length copy is no longer needed
    delete nextMeta.full_original;
    await deleteBunnyVideoQuietly(md.full_original.bunny_video_id);
  }
  // keep a custom thumbnail; drop one that pointed at the old Bunny copy
  const thumb =
    row.thumbnail_url && oldGuid && String(row.thumbnail_url).includes(oldGuid)
      ? null
      : row.thumbnail_url || null;
  const { rows } = await db.query(
    `UPDATE videos
        SET provider = 'bunny_stream',
            provider_key = $2,
            bunny_video_id = $2,
            bunny_library_id = $3,
            video_url = $4,
            playback_url = $4,
            embed_url = $5,
            processing_status = 'ready',
            duration_seconds = CASE WHEN $6::int > 0 THEN $6::int ELSE duration_seconds END,
            thumbnail_url = $7,
            metadata = $8::jsonb,
            updated_at = NOW()
      WHERE id = $1
      RETURNING *`,
    [
      row.id,
      guid,
      String(LIB_ID),
      urls.playbackUrl || urls.hlsUrl || "",
      urls.embedUrl || "",
      length,
      thumb,
      JSON.stringify(nextMeta),
    ],
  );
  if (
    oldGuid &&
    oldGuid !== guid &&
    !keepOld &&
    oldGuid !== md.full_original?.bunny_video_id
  )
    await deleteBunnyVideoQuietly(oldGuid);
  return { state: "done", video: rows[0] };
}

router.post(
  "/bunny/stream/replace/:id/start",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      if (!LIB_ID || !API_KEY)
        return res
          .status(500)
          .json({ ok: false, message: "Bunny Stream env not configured." });
      const id = Number(req.params.id);
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        id,
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const row = q.rows[0];
      const md = metaOf(row);
      // a previous unfinished replacement is discarded
      if (
        md.replace_pending?.bunny_video_id &&
        md.replace_pending.status !== "done"
      )
        await deleteBunnyVideoQuietly(md.replace_pending.bunny_video_id);
      const created = await bunnyJson(
        `https://video.bunnycdn.com/library/${LIB_ID}/videos`,
        {
          method: "POST",
          body: JSON.stringify({ title: String(row.title || "Untitled") }),
        },
      );
      const videoId = created?.guid || created?.videoId || created?.id;
      if (!videoId)
        return res
          .status(500)
          .json({ ok: false, message: "Bunny did not return a video id." });
      const expires = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
      const signature = crypto
        .createHash("sha256")
        .update(`${LIB_ID}${API_KEY}${expires}${videoId}`)
        .digest("hex");
      const pending = {
        bunny_video_id: videoId,
        status: "uploading",
        started_at: new Date().toISOString(),
        filename: String(req.body?.filename || "").slice(0, 200) || null,
      };
      await db.query(
        `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
        [id, JSON.stringify({ replace_pending: pending })],
      );
      return res.json({
        ok: true,
        videoId,
        libraryId: String(LIB_ID),
        signature,
        expires,
        tusEndpoint: "https://video.bunnycdn.com/tusupload",
      });
    } catch (err) {
      console.error("[bunnyStream] replace start error:", err);
      return res
        .status(500)
        .json({
          ok: false,
          message: err?.message || "Could not start the replacement",
        });
    }
  },
);

router.get(
  "/bunny/stream/replace/:id/status",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      res.set("Cache-Control", "no-store");
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        Number(req.params.id),
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const r = await checkReplacement(q.rows[0]);
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error("[bunnyStream] replace status error:", err);
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Status check failed" });
    }
  },
);

router.delete(
  "/bunny/stream/replace/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        id,
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const pending = metaOf(q.rows[0]).replace_pending;
      if (pending?.bunny_video_id)
        await deleteBunnyVideoQuietly(pending.bunny_video_id);
      await db.query(
        `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) - 'replace_pending', updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return res.json({ ok: true });
    } catch (err) {
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Cancel failed" });
    }
  },
);

/* ------------------------------------------------------------------
 * REPLACE FROM WASABI — Bunny Stream fetches the file straight from Wasabi
 * (signed 24-hour link) into the SAME message; then the normal Replace flow
 * (switch-over when ready, old copy removed) takes over.
 *   GET  /bunny/stream/replace/:id/wasabi-suggest  → the message's saved Wasabi file
 *   POST /bunny/stream/replace/:id/from-wasabi     { key }
 *   POST /bunny/stream/replace-failed-from-wasabi  every failed message with a known Wasabi file
 * ------------------------------------------------------------------ */
function wasabiKeyOf(row) {
  const md = metaOf(row);
  let sm = row?.source_meta || {};
  if (typeof sm === "string") {
    try {
      sm = JSON.parse(sm);
    } catch {
      sm = {};
    }
  }
  const imp =
    md.wasabi_import && typeof md.wasabi_import === "object"
      ? md.wasabi_import
      : {};
  const k = [
    row?.wasabi_key,
    sm.wasabi_key,
    sm.key,
    sm.original_key,
    md.wasabi_key,
    md.source_key,
    md.original_key,
    imp.key,
    imp.wasabi_key,
  ]
    .map((x) => String(x || "").trim())
    .find((x) => x && !/^https?:/i.test(x));
  return k || "";
}

// Wasabi files are named by the service date (BRTV-042626_1.mp4 for 4-26-26).
// Find the files whose name has the date from the message title.
async function wasabiCandidatesByDate(row) {
  const m = String(row?.title || "").match(
    /(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})(?!.*\d{1,2}-\d{1,2}-\d{2})/,
  );
  if (!m) return [];
  const code = `${m[1].padStart(2, "0")}${m[2].padStart(2, "0")}${m[3].slice(-2)}`;
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT key FROM wasabi_object_index
        WHERE key ~* $1 AND key ~* '\\.(mp4|mov|m4v)$'
        ORDER BY key LIMIT 10`,
      [`(^|/)BRTV-${code}([_.-]|$)`],
    );
    return rows.map((r) => r.key);
  } catch {
    return []; // the Wasabi file list has not been created yet
  }
}

async function startReplaceFromWasabi(row, key) {
  if (!LIB_ID || !API_KEY) throw new Error("Bunny Stream env not configured.");
  const wasabi = require("../services/wasabi");
  const cleanKey = String(key || "")
    .trim()
    .replace(/^\/+/, "");
  if (!cleanKey) throw new Error("Choose a file from Wasabi.");
  try {
    await wasabi.headObject(cleanKey);
  } catch (e) {
    throw new Error(
      `The file "${cleanKey}" was not found in Wasabi. Nothing was changed.`,
    );
  }
  const url = await wasabi.signGetUrl(cleanKey, 24 * 60 * 60);
  // make sure Wasabi really serves the link before asking Bunny
  const status = await probeDownload(url);
  if (status !== 200 && status !== 206) {
    throw new Error(
      `Wasabi refused the download link for "${cleanKey}" (${status}). Check the Wasabi keys on the server. Nothing was changed.`,
    );
  }
  // a previous unfinished replacement is discarded
  const md = metaOf(row);
  if (
    md.replace_pending?.bunny_video_id &&
    md.replace_pending.status !== "done"
  )
    await deleteBunnyVideoQuietly(md.replace_pending.bunny_video_id);

  const originalTitle = String(row.title || "Untitled").trim() || "Untitled";
  const uniqueTitle = `${originalTitle} [NLM-WASABI-${row.id}-${Date.now()}]`;
  await bunnyJson(`https://video.bunnycdn.com/library/${LIB_ID}/videos/fetch`, {
    method: "POST",
    body: JSON.stringify({ url, title: uniqueTitle, headers: {} }),
  });
  let bunnyVideo = null;
  for (let i = 0; i < 10; i += 1) {
    bunnyVideo = await findBunnyVideoByExactTitle(uniqueTitle);
    if (bunnyVideo?.guid) break;
    await sleep(800);
  }
  if (!bunnyVideo?.guid)
    throw new Error(
      "Bunny started fetching from Wasabi, but the new copy was not found yet. Wait a minute and check again.",
    );
  await updateBunnyVideoTitle(bunnyVideo.guid, originalTitle);
  const pending = {
    bunny_video_id: bunnyVideo.guid,
    status: "processing",
    started_at: new Date().toISOString(),
    source: "wasabi",
    wasabi_key: cleanKey,
  };
  await db.query(
    `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
    [row.id, JSON.stringify({ replace_pending: pending })],
  );
  return { started: true, bunnyVideoId: bunnyVideo.guid, key: cleanKey };
}

router.get(
  "/bunny/stream/replace/:id/wasabi-suggest",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        Number(req.params.id),
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const saved = wasabiKeyOf(q.rows[0]);
      if (saved) return res.json({ ok: true, key: saved });
      const candidates = await wasabiCandidatesByDate(q.rows[0]);
      if (candidates.length === 1)
        return res.json({ ok: true, key: candidates[0], matchedByDate: true });
      return res.json({ ok: true, key: null, candidates });
    } catch (err) {
      return res
        .status(500)
        .json({
          ok: false,
          message: err?.message || "Could not read the video",
        });
    }
  },
);

router.post(
  "/bunny/stream/replace/:id/from-wasabi",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        Number(req.params.id),
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const r = await startReplaceFromWasabi(q.rows[0], req.body?.key);
      return res.json({ ok: true, ...r });
    } catch (err) {
      console.error(
        "[bunnyStream] replace from Wasabi error:",
        err?.message || err,
      );
      return res
        .status(400)
        .json({
          ok: false,
          message: err?.message || "Could not start the import from Wasabi",
        });
    }
  },
);

router.post(
  "/bunny/stream/replace-failed-from-wasabi",
  authenticate,
  retryAccess,
  async (_req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM videos
        WHERE LOWER(COALESCE(provider, '')) = 'bunny_stream'
          AND LOWER(COALESCE(processing_status, '')) IN ('error', 'failed')
        ORDER BY id DESC LIMIT 50`,
      );
      const started = [];
      const unmatched = [];
      const failed = [];
      for (const row of rows) {
        let key = wasabiKeyOf(row);
        let byDate = false;
        if (!key) {
          const candidates = await wasabiCandidatesByDate(row);
          if (candidates.length === 1) {
            key = candidates[0];
            byDate = true;
          } else {
            unmatched.push({ id: row.id, title: row.title, candidates });
            continue;
          }
        }
        try {
          await startReplaceFromWasabi(row, key);
          started.push({
            id: row.id,
            title: row.title,
            key,
            matchedByDate: byDate,
          });
        } catch (e) {
          failed.push({
            id: row.id,
            title: row.title,
            message: e?.message || "failed",
          });
        }
      }
      return res.json({
        ok: true,
        found: rows.length,
        started: started.length,
        unmatched,
        failed,
      });
    } catch (err) {
      return res
        .status(500)
        .json({ ok: false, message: err?.message || "Re-import failed" });
    }
  },
);

/* ------------------------------------------------------------------
 * SOURCE FILE — every file name this message has had, and the Wasabi files
 * that may be its original (same name, or the date in the title).
 *   GET /bunny/stream/source/:id
 * ------------------------------------------------------------------ */
const MEDIA_EXT =
  /\.(mp4|m4v|mov|mkv|webm|avi|wmv|mpg|mpeg|mts|m2ts|flv|3gp)$/i;
function fileNameFrom(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname;
  } catch {
    /* not a URL */
  }
  let name = path.split("/").filter(Boolean).pop() || "";
  try {
    name = decodeURIComponent(name);
  } catch {
    /* keep */
  }
  return MEDIA_EXT.test(name) ? name : "";
}
function pathFrom(value) {
  try {
    if (/^https?:\/\//i.test(String(value))) {
      const u = new URL(String(value));
      return `${u.hostname}${decodeURIComponent(u.pathname)}`;
    }
  } catch {
    /* ignore */
  }
  return String(value || "");
}

router.get(
  "/bunny/stream/source/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    try {
      const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
        Number(req.params.id),
      ]);
      if (!q.rowCount)
        return res.status(404).json({ ok: false, message: "Video not found" });
      const row = q.rows[0];
      const md = metaOf(row);
      let sm = row.source_meta || {};
      if (typeof sm === "string") {
        try {
          sm = JSON.parse(sm);
        } catch {
          sm = {};
        }
      }
      const found = [];
      const add = (label, value) => {
        const name = fileNameFrom(value);
        if (!name || found.some((f) => f.name === name && f.label === label))
          return;
        found.push({ label, name, path: pathFrom(value) });
      };
      // where the message's files came from, most useful first
      for (const m of [md.bunny_stream_migration, md.previous_migration])
        if (m?.source_url) add("Original file (Bunny Storage)", m.source_url);
      if (row.wasabi_key) add("Wasabi file", row.wasabi_key);
      if (md.wasabi_import?.key) add("Wasabi file", md.wasabi_import.key);
      if (md.cloud_import?.key) add("Cloud storage file", md.cloud_import.key);
      if (md.file_replaced?.filename)
        add("Uploaded file (replaced)", md.file_replaced.filename);
      if (md.file_replaced?.previous_video_url)
        add("Earlier file", md.file_replaced.previous_video_url);
      // any other saved file name / address
      const scan = (obj, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 3) return;
        for (const [k, v] of Object.entries(obj)) {
          if (
            typeof v === "string" &&
            /(file|name|key|url|source|path)/i.test(k)
          )
            add(
              /url|path/i.test(k) && /^https?:/i.test(v)
                ? "File address"
                : "File name",
              v,
            );
          else if (v && typeof v === "object") scan(v, depth + 1);
        }
      };
      scan(sm);
      scan(md);
      const isStreamAddress = (u) =>
        /mediadelivery\.net|vz-[a-z0-9-]+\.b-cdn\.net/i.test(String(u || ""));
      if (row.video_url && !isStreamAddress(row.video_url))
        add("Current file address", row.video_url);

      // Wasabi files that may be the original: same name (without the extension), or the title's date
      const wasabi = new Set();
      try {
        for (const f of found) {
          const base = f.name.replace(MEDIA_EXT, "");
          if (base.length < 4) continue;
          const { rows } = await db.query(
            `SELECT DISTINCT key FROM wasabi_object_index WHERE key ILIKE $1 ORDER BY key LIMIT 5`,
            [`%${base}%`],
          );
          rows.forEach((r) => wasabi.add(r.key));
        }
      } catch {
        /* no Wasabi file list yet */
      }
      for (const k of await wasabiCandidatesByDate(row)) wasabi.add(k);
      // why Bunny could not encode the message's current copy (and the last replacement)
      const bunny_errors = [];
      const st = String(row.processing_status || "").toLowerCase();
      const ids = [];
      if ((st === "error" || st === "failed") && row.bunny_video_id)
        ids.push(["Current copy", row.bunny_video_id]);
      if (
        md.replace_pending?.bunny_video_id &&
        md.replace_pending.status === "error"
      )
        ids.push(["Last replacement", md.replace_pending.bunny_video_id]);
      for (const [label, guid] of ids) {
        try {
          const bv = await getBunnyVideoById(guid);
          if (!bv)
            bunny_errors.push({
              label,
              reasons: ["No longer in the Bunny library."],
            });
          else
            bunny_errors.push({
              label,
              status: bv.status,
              reasons: bunnyReasons(bv),
            });
        } catch {
          /* Bunny unreachable: skip */
        }
      }
      return res.json({
        ok: true,
        files: found,
        wasabi_matches: [...wasabi].slice(0, 10),
        bunny_errors,
        trim: md.trim_state || null,
      });
    } catch (err) {
      return res
        .status(500)
        .json({
          ok: false,
          message: err?.message || "Could not read the source file",
        });
    }
  },
);

/* ------------------------------------------------------------------
 * QUICK REPAIR & RE-IMPORT — for files Bunny cannot encode ("Transcoding
 * failed"). The server reads the original (Wasabi file, else the original
 * Bunny Storage file), repairs it with ffmpeg (services/repairVideo.js: timing,
 * index and sound; the picture is copied as is), uploads it to Bunny and the
 * safe Replace flow switches the message over when Bunny is ready.
 * One repair at a time.
 *   POST /bunny/stream/repair/:id    start (or join the queue)
 *   GET  /bunny/stream/repair/:id    queued / repairing / uploading / encoding / done / error
 * ------------------------------------------------------------------ */
const repairJobs = new Map(); // video id -> { state, progress, message, bunny_video_id }
const repairQueue = [];
let repairRunning = false;
const setRepair = (id, patch) =>
  repairJobs.set(Number(id), {
    ...(repairJobs.get(Number(id)) || {}),
    ...patch,
    at: Date.now(),
  });

async function repairSourceUrl(row, { allowStreamOriginal = false } = {}) {
  // For a trim: if the video now playing did not come from the Wasabi file
  // (an upload, a repair, a Cloud Storage import, or an earlier trim cut from
  // Bunny), the Wasabi file is out of date — use Bunny's kept original instead.
  if (allowStreamOriginal) {
    const mdx = metaOf(row);
    const src = String(mdx.file_replaced?.source || "");
    const fromBunny =
      mdx.full_original?.bunny_video_id ||
      (src && !["wasabi", "trim", "migration"].includes(src));
    if (fromBunny) {
      for (const [guid, label] of [
        [mdx.full_original?.bunny_video_id, "the full-length Bunny copy"],
        [row.bunny_video_id, "the Bunny Stream original"],
      ]) {
        if (!guid) continue;
        const url = `https://${STREAM_CDN_HOST}/${guid}/original`;
        const st = await probeDownload(url);
        if (st === 200 || st === 206) return { url, from: label };
      }
      throw new Error(
        "This message’s current video was uploaded or replaced outside Wasabi, and Bunny does not keep its original file. " +
          "Turn on “Keep original files” in the Bunny Stream library (Encoding settings) for new uploads, or upload the full video again with “Choose new file”.",
      );
    }
  }
  const key =
    wasabiKeyOf(row) ||
    ((await wasabiCandidatesByDate(row)).length === 1
      ? (await wasabiCandidatesByDate(row))[0]
      : "");
  if (key) {
    try {
      const wasabi = require("../services/wasabi");
      await wasabi.headObject(key);
      const url = await wasabi.signGetUrl(key, 6 * 60 * 60);
      const st = await probeDownload(url);
      if (st === 200 || st === 206)
        return { url, from: `Wasabi (${key.split("/").pop()})` };
    } catch {
      /* try the next source */
    }
  }
  const md = metaOf(row);
  for (const m of [md.bunny_stream_migration, md.previous_migration]) {
    const original = String(m?.source_url || "").trim();
    if (
      !original ||
      /vz-[a-z0-9-]+\.b-cdn\.net|mediadelivery\.net/i.test(original)
    )
      continue;
    const pick = await pickDownloadableSource(original);
    if (pick.ok)
      return { url: pick.url, from: "the original Bunny Storage file" };
  }
  // Bunny Stream keeps the uploaded original when "Keep original files" is on
  if (
    allowStreamOriginal &&
    row.bunny_video_id &&
    String(row.processing_status || "").toLowerCase() !== "error"
  ) {
    const url = `https://${STREAM_CDN_HOST}/${row.bunny_video_id}/original`;
    const st = await probeDownload(url);
    if (st === 200 || st === 206)
      return { url, from: "the Bunny Stream original" };
  }
  throw new Error(
    allowStreamOriginal
      ? "No original file could be read for this message (Wasabi, Bunny Storage, or Bunny Stream’s kept original). Trimming needs the original file."
      : "No original file could be read for this message (Wasabi or Bunny Storage). Convert the file on a computer and use “Choose new file”.",
  );
}

async function uploadFileToBunny(guid, filePath, onProgress) {
  const fs = require("fs");
  const size = fs.statSync(filePath).size;
  let sent = 0;
  const stream = fs.createReadStream(filePath);
  stream.on("data", (chunk) => {
    sent += chunk.length;
    onProgress(Math.min(99, Math.round((sent / size) * 100)));
  });
  const r = await fetch(
    `https://video.bunnycdn.com/library/${LIB_ID}/videos/${guid}`,
    {
      method: "PUT",
      headers: {
        AccessKey: API_KEY,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
      },
      body: stream,
    },
  );
  if (!r.ok)
    throw new Error(`Bunny did not accept the repaired file (${r.status}).`);
  onProgress(100);
}

async function runRepair(id) {
  const os = require("os");
  const path = require("path");
  const fs = require("fs");
  const {
    quickRepair,
    fullConvert,
    trimFile,
    downloadToFile,
  } = require("../services/repairVideo");
  const job = repairJobs.get(id) || {};
  const isTrim = job.kind === "trim";
  const tmp = path.join(os.tmpdir(), `brtv-repair-${id}-${Date.now()}.mp4`);
  const tmpIn = path.join(
    os.tmpdir(),
    `brtv-repair-${id}-${Date.now()}-original`,
  );
  try {
    const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
      id,
    ]);
    const row = q.rows[0];
    if (!row) throw new Error("Video not found.");
    setRepair(id, {
      state: "repairing",
      progress: 0,
      message: "Reading the original file…",
    });
    const src = await repairSourceUrl(row, { allowStreamOriginal: isTrim });
    // download first: ffmpeg only reads local files (see services/repairVideo.js)
    setRepair(id, {
      state: "downloading",
      progress: 0,
      message: `Downloading the original file from ${src.from}…`,
    });
    await downloadToFile(src.url, tmpIn, (p) => setRepair(id, { progress: p }));
    setRepair(id, { state: "repairing", progress: 0 });
    if (isTrim) {
      setRepair(id, { message: `Cutting the video…` });
      await trimFile(tmpIn, tmp, job.start, job.end, (p) =>
        setRepair(id, { progress: p }),
      );
    } else if (job.mode === "full") {
      setRepair(id, {
        message: "Converting the file (full conversion — slow)…",
      });
      await fullConvert(tmpIn, tmp, (p) => setRepair(id, { progress: p }));
    } else {
      setRepair(id, { message: "Repairing the file…" });
      try {
        await quickRepair(tmpIn, tmp, (p) => setRepair(id, { progress: p }));
      } catch (first) {
        if (first.crashed) throw first;
        // second attempt: rebuild the timing from scratch
        setRepair(id, {
          progress: 0,
          message: "Repairing the file (second attempt)…",
        });
        try {
          await quickRepair(tmpIn, tmp, (p) => setRepair(id, { progress: p }), {
            attempt: 2,
          });
        } catch (second) {
          if (second.crashed) throw second;
          const e = new Error(
            `${second.message} Quick repair cannot fix this file — use “Full conversion” (slow), which re-encodes the picture too.`,
          );
          e.suggestFull = true;
          throw e;
        }
      }
    }

    setRepair(id, {
      state: "uploading",
      progress: 0,
      message: isTrim
        ? "Sending the trimmed video to Bunny…"
        : "Sending the repaired file to Bunny…",
    });
    const created = await bunnyJson(
      `https://video.bunnycdn.com/library/${LIB_ID}/videos`,
      {
        method: "POST",
        body: JSON.stringify({ title: String(row.title || "Untitled") }),
      },
    );
    const guid = created?.guid || created?.videoId || created?.id;
    if (!guid) throw new Error("Bunny did not return a video id.");
    await uploadFileToBunny(guid, tmp, (p) => setRepair(id, { progress: p }));

    // the safe Replace flow takes over (switch-over when ready, old copy removed)
    const md = metaOf(row);
    if (
      md.replace_pending?.bunny_video_id &&
      md.replace_pending.bunny_video_id !== guid &&
      md.replace_pending.status !== "done"
    ) {
      await deleteBunnyVideoQuietly(md.replace_pending.bunny_video_id);
    }
    await db.query(
      `UPDATE videos SET metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [
        id,
        JSON.stringify({
          replace_pending: {
            bunny_video_id: guid,
            status: "processing",
            started_at: new Date().toISOString(),
            source: isTrim ? "trim" : "repair",
            filename: isTrim ? "trimmed.mp4" : "repaired.mp4",
            ...(isTrim
              ? {
                  trim: {
                    start: job.start,
                    end: job.end,
                    from: src.from,
                    ...(job.restore ? { restore: true } : {}),
                  },
                }
              : {}),
          },
        }),
      ],
    );
    setRepair(id, {
      state: "encoding",
      progress: 0,
      bunny_video_id: guid,
      message: isTrim
        ? "Bunny is encoding the trimmed video…"
        : "Bunny is encoding the repaired file…",
    });
  } catch (e) {
    setRepair(id, {
      state: "error",
      suggestFull:
        !!e.suggestFull || (!isTrim && job.mode !== "full" && !e.crashed),
      message:
        e.message || (isTrim ? "The trim failed." : "The repair failed."),
    });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
    fs.promises.unlink(tmpIn).catch(() => {});
  }
}

async function pumpRepairs() {
  if (repairRunning) return;
  const id = repairQueue.shift();
  if (id == null) return;
  repairRunning = true;
  try {
    await runRepair(id);
  } finally {
    repairRunning = false;
    pumpRepairs();
  }
}

router.post(
  "/bunny/stream/repair/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid video ID" });
    if (!LIB_ID || !API_KEY)
      return res
        .status(500)
        .json({ ok: false, message: "Bunny Stream env not configured." });
    const cur = repairJobs.get(id);
    if (
      cur &&
      ["queued", "downloading", "repairing", "uploading"].includes(cur.state)
    )
      return res.json({ ok: true, ...cur });
    const mode = req.body?.mode === "full" ? "full" : "quick";
    setRepair(id, {
      kind: "repair",
      mode,
      suggestFull: false,
      state: "queued",
      progress: 0,
      message: repairRunning
        ? "Waiting for another job to finish…"
        : "Starting…",
      bunny_video_id: null,
    });
    repairQueue.push(id);
    pumpRepairs();
    return res.json({ ok: true, ...repairJobs.get(id) });
  },
);

// Trim: keep only start → end (seconds) of the message's original file.
router.post(
  "/bunny/stream/trim/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id))
      return res.status(400).json({ ok: false, message: "Invalid video ID" });
    if (!LIB_ID || !API_KEY)
      return res
        .status(500)
        .json({ ok: false, message: "Bunny Stream env not configured." });
    let start = Number(req.body?.start);
    let end = Number(req.body?.end);
    const q = await db.query(
      "SELECT id, duration_seconds, metadata FROM videos WHERE id = $1",
      [id],
    );
    if (!q.rowCount)
      return res.status(404).json({ ok: false, message: "Video not found" });
    const trimState = metaOf(q.rows[0]).trim_state || null;
    // times are on the FULL recording (a trimmed message is always cut from it)
    const duration =
      Number(trimState?.full_duration) ||
      Number(q.rows[0].duration_seconds) ||
      0;
    const restore = req.body?.restore === true;
    if (restore) {
      if (!trimState)
        return res
          .status(400)
          .json({ ok: false, message: "This message is not trimmed." });
      start = 0;
      end = duration || 24 * 3600;
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start
    )
      return res
        .status(400)
        .json({
          ok: false,
          message: "Enter a start time and an end time after it.",
        });
    if (end - start < 10)
      return res
        .status(400)
        .json({ ok: false, message: "Keep at least 10 seconds of video." });
    if (duration && end > duration + 1)
      return res
        .status(400)
        .json({
          ok: false,
          message: `The end time is after the end of the video (${duration} s).`,
        });
    if (!restore && start === 0 && duration && end >= duration)
      return res
        .status(400)
        .json({
          ok: false,
          message: trimState
            ? "To bring back the whole video, use “Restore full video”."
            : "Nothing to trim: the times cover the whole video.",
        });
    const cur = repairJobs.get(id);
    if (
      cur &&
      ["queued", "downloading", "repairing", "uploading", "encoding"].includes(
        cur.state,
      )
    )
      return res
        .status(409)
        .json({
          ok: false,
          message: "This message already has a repair or trim in progress.",
        });
    setRepair(id, {
      kind: "trim",
      start,
      end,
      restore,
      state: "queued",
      progress: 0,
      message: repairRunning
        ? "Waiting for another job to finish…"
        : "Starting…",
      bunny_video_id: null,
    });
    repairQueue.push(id);
    pumpRepairs();
    return res.json({ ok: true, ...repairJobs.get(id) });
  },
);

router.get(
  "/bunny/stream/repair/:id",
  authenticate,
  retryAccess,
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const id = Number(req.params.id);
    const job = repairJobs.get(id);
    if (!job) return res.json({ ok: true, state: "none" });
    // (shared by "Repair & re-import" and "Trim video": job.kind)
    if (job.state === "encoding") {
      try {
        const q = await db.query("SELECT * FROM videos WHERE id = $1 LIMIT 1", [
          id,
        ]);
        const r = q.rows[0]
          ? await checkReplacement(q.rows[0])
          : { state: "none" };
        if (r.state === "done")
          setRepair(id, {
            state: "done",
            progress: 100,
            message:
              job.kind === "trim"
                ? job.restore
                  ? "Restored — the message plays the full video again."
                  : "Trimmed — the message now plays the trimmed video. Change the times and trim again, or use “Restore full video”."
                : job.mode === "full"
                  ? "Converted — the message now plays the converted file."
                  : "Repaired — the message now plays the repaired file.",
          });
        else if (r.state === "error")
          setRepair(id, {
            state: "error",
            message:
              job.kind === "trim"
                ? `Bunny could not encode the trimmed video.${r.reasons?.length ? ` Bunny says: ${r.reasons.join(" · ")}.` : ""} The message still plays its full video.`
                : `Bunny still could not encode the repaired file.${r.reasons?.length ? ` Bunny says: ${r.reasons.join(" · ")}.` : ""} It needs a full conversion: HandBrake (“Fast 1080p30”, MP4), then “Choose new file”.`,
          });
        else if (r.state === "processing" || r.state === "uploading")
          setRepair(id, { progress: Number(r.progress) || 0 });
      } catch {
        /* try again next time */
      }
    }
    return res.json({ ok: true, ...repairJobs.get(id) });
  },
);

// Finish replacements in the background (the admin may close the page while
// Bunny is still encoding). Every 5 minutes.
async function finishPendingReplacements() {
  if (!LIB_ID || !API_KEY) return;
  try {
    const { rows } = await db.query(
      `SELECT * FROM videos WHERE metadata ? 'replace_pending' AND COALESCE(metadata->'replace_pending'->>'status', '') <> 'error' LIMIT 50`,
    );
    for (const row of rows) {
      try {
        await checkReplacement(row);
      } catch (e) {
        console.warn("[bunnyStream] replacement check:", e.message);
      }
    }
  } catch (e) {
    console.warn("[bunnyStream] replacement checks:", e.message);
  }
}
if (process.env.NODE_ENV !== "test") {
  const t = setInterval(finishPendingReplacements, 5 * 60 * 1000);
  t.unref?.();
}

// called by lib/bunnyConfig.js when the Bunny connection changes
function refreshBunnyConfig() {
  LIB_ID = String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim();
  API_KEY = String(process.env.BUNNY_STREAM_API_KEY || "").trim();
  STREAM_CDN_HOST = String(
    process.env.BUNNY_STREAM_CDN_HOST ||
      process.env.BUNNY_STREAM_PULL_ZONE_URL ||
      `vz-${LIB_ID}.b-cdn.net`,
  )
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
}

module.exports = router;
module.exports.refreshBunnyConfig = refreshBunnyConfig;
