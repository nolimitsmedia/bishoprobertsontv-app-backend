// server-api/routes/videos.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const fetch = require("node-fetch");
const { getDurationSeconds } = require("../services/mediaMeta");

// 🔔 Centralized FCM sender (Admin SDK with legacy fallback)
const { sendPush } = require("../notifications/fcm");

/* -------------------- helpers -------------------- */

function isAdmin(user) {
  const r = (user?.role || user?.type || "").toLowerCase();
  return r === "admin" || r === "owner";
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

function ensureArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Non-negative integer (or 0) */
function coerceNonNegInt(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

/** Resolve duration from flexible body keys; return seconds (int) or null */
function resolveDurationSeconds(body = {}) {
  if (body.duration_seconds != null) {
    const s = Math.round(num(body.duration_seconds));
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  if (body.duration_sec != null) {
    const s = Math.round(num(body.duration_sec));
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  if (body.duration != null) {
    const s = Math.round(num(body.duration));
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  if (
    body.duration_minutes != null ||
    body.duration_mins != null ||
    body.duration_min != null
  ) {
    const m = num(
      body.duration_minutes ?? body.duration_mins ?? body.duration_min,
    );
    const s = Math.round(m * 60);
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  if (
    body.duration_hours != null ||
    body.duration_hrs != null ||
    body.duration_hr != null
  ) {
    const h = num(body.duration_hours ?? body.duration_hrs ?? body.duration_hr);
    const s = Math.round(h * 3600);
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  if (body.duration_ms != null || body.durationMillis != null) {
    const ms = num(body.duration_ms ?? body.durationMillis);
    const s = Math.round(ms / 1000);
    return Number.isFinite(s) && s > 0 ? s : null;
  }
  return null;
}

/** Map a video_url (absolute or relative) to a local file under /uploads if it exists */
function resolveLocalUploadPath(videoUrl) {
  try {
    if (!videoUrl) return null;
    let p = String(videoUrl);

    // If absolute URL, take the pathname
    if (/^https?:\/\//i.test(p)) {
      try {
        p = new URL(p).pathname;
      } catch (_) {}
    }

    // Normalize: strip leading slashes
    p = p.replace(/^\/+/, "");

    // Must be under uploads/
    const m = p.match(/^uploads\/(.+)$/i);
    if (!m) return null;

    const raw = m[1];
    const decoded = decodeURIComponent(raw);

    const uploadsDir = path.join(__dirname, "..", "uploads");
    const candidates = [raw, decoded];

    for (const file of candidates) {
      const full = path.join(uploadsDir, file);
      if (fs.existsSync(full)) return full;
    }
    return null;
  } catch {
    return null;
  }
}

/** If video_url points to /uploads/..., try probing the local file (handles absolute + encoded) */
async function detectDurationFromUrlMaybeLocal(videoUrl) {
  try {
    const local = resolveLocalUploadPath(videoUrl);
    if (!local) return null;
    const sec = await getDurationSeconds(local);
    return Number.isFinite(sec) && sec > 0 ? Math.round(sec) : null;
  } catch {
    return null;
  }
}

function buildMetadataFromBody(body) {
  const {
    seo_title,
    seo_description,
    tags,
    resources, // [{title,url}]
    subtitles, // [{lang,url}]
    audio_track, // {url}
    trailer, // {url}
    pricing, // {rental:{currency,price,duration_days}, purchase:{currency,price}, upsell_text}
    authors, // [string]
    custom_filters, // [string] or [{key,value}]
  } = body;

  const md = {};
  if (seo_title !== undefined) md.seo_title = String(seo_title || "");
  if (seo_description !== undefined)
    md.seo_description = String(seo_description || "");
  if (tags !== undefined) md.tags = ensureArray(tags).map(String);

  if (resources !== undefined)
    md.resources = ensureArray(resources).map((r) => ({
      title: String(r.title || ""),
      url: String(r.url || ""),
    }));

  if (subtitles !== undefined)
    md.subtitles = ensureArray(subtitles).map((s) => ({
      lang: String(s.lang || ""),
      url: String(s.url || ""),
    }));

  if (audio_track !== undefined)
    md.audio_track = audio_track
      ? { url: String(audio_track.url || "") }
      : null;
  if (trailer !== undefined)
    md.trailer = trailer ? { url: String(trailer.url || "") } : null;

  if (pricing !== undefined) {
    md.pricing = {
      rental: pricing?.rental
        ? {
            currency: String(pricing.rental.currency || "USD"),
            price: Number(pricing.rental.price || 0),
            duration_days: Number(pricing.rental.duration_days || 0),
          }
        : null,
      purchase: pricing?.purchase
        ? {
            currency: String(pricing.purchase.currency || "USD"),
            price: Number(pricing.purchase.price || 0),
          }
        : null,
      upsell_text: String(pricing?.upsell_text || ""),
    };
  }

  if (authors !== undefined) md.authors = ensureArray(authors).map(String);
  if (custom_filters !== undefined)
    md.custom_filters = ensureArray(custom_filters);

  // passthrough meta fields used in UI (geo, vertical thumb)
  if (body.geo_allow !== undefined) md.geo_allow = ensureArray(body.geo_allow);
  if (body.geo_block !== undefined) md.geo_block = ensureArray(body.geo_block);
  if (body.thumbnail_vertical_url !== undefined)
    md.thumbnail_vertical_url = String(body.thumbnail_vertical_url || "");

  return md;
}

function mergeJson(a, b) {
  return { ...(a || {}), ...(b || {}) };
}

async function assertOwnerOrAdmin(videoId, user) {
  const q = await db.query(
    "SELECT id, created_by FROM videos WHERE id=$1 LIMIT 1",
    [videoId],
  );
  if (q.rowCount === 0) return { ok: false, status: 404 };
  const row = q.rows[0];
  if (isAdmin(user)) return { ok: true, row };
  if (row.created_by && String(row.created_by) === String(user?.id))
    return { ok: true, row };
  return { ok: false, status: 403 };
}

function normalizeVisibility(v) {
  const val = String(v || "").toLowerCase();
  return ["public", "private", "unlisted"].includes(val) ? val : "private";
}

function isDigits(x) {
  return typeof x === "string" && /^\d+$/.test(x);
}

/** ✅ Robust date parsing for published_at
 * Fix: treat "YYYY-MM-DD" as a DATE (local midnight), not as UTC string parsing.
 * This prevents off-by-one/day drift in some timezones.
 */
function parseDateInput(v) {
  if (v === undefined) return undefined; // not provided
  if (v === null || v === "") return null;

  // Date object passthrough
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "__invalid__";
    return v;
  }

  // timestamp (ms)
  if (typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v))) {
    const ms = Number(v);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return "__invalid__";
    return d;
  }

  const s = String(v).trim();

  // ✅ "YYYY-MM-DD" => local midnight (avoid UTC parsing quirks)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const yyyy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);

    if (mm < 1 || mm > 12) return "__invalid__";
    const dim = new Date(yyyy, mm, 0).getDate();
    if (dd < 1 || dd > dim) return "__invalid__";

    const d = new Date(yyyy, mm - 1, dd, 0, 0, 0, 0); // local midnight
    if (Number.isNaN(d.getTime())) return "__invalid__";
    return d;
  }

  // ISO / other strings
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "__invalid__";
  return d;
}

/* ---------- SQL helper: safe preview seconds from column OR metadata ---------- */
const PREVIEW_SECONDS_SQL = `
  GREATEST(0,
    COALESCE(
      v.free_preview_seconds,
      CASE WHEN (v.metadata->>'free_preview_seconds') ~ '^\\s*\\d+\\s*$'
           THEN (v.metadata->>'free_preview_seconds')::int END,
      CASE WHEN (v.metadata->>'preview_seconds') ~ '^\\s*\\d+\\s*$'
           THEN (v.metadata->>'preview_seconds')::int END,
      CASE WHEN (v.metadata->>'freePreviewSeconds') ~ '^\\s*\\d+\\s*$'
           THEN (v.metadata->>'freePreviewSeconds')::int END,
      CASE WHEN (v.metadata->>'previewSeconds') ~ '^\\s*\\d+\\s*$'
           THEN (v.metadata->>'previewSeconds')::int END,
      0
    )
  ) AS free_preview_seconds
`;

/* -------------------- ADMIN VIDEO LIST PERFORMANCE INDEXES -------------------- */
let videoListIndexesStarted = false;
function ensureVideoListIndexes() {
  if (videoListIndexesStarted) return;
  videoListIndexesStarted = true;

  // Fire-and-forget: these indexes speed up the admin Videos page filtering,
  // sorting, ownership checks, and pagination without blocking every request.
  const statements = [
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_published_at ON videos (published_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_updated_at ON videos (updated_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_created_at ON videos (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_title_lower ON videos (LOWER(title))",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_category_id ON videos (category_id)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_created_by ON videos (created_by)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_published ON videos (is_published)",
    "CREATE INDEX IF NOT EXISTS idx_videos_admin_provider_status ON videos (provider, processing_status)",
  ];

  Promise.allSettled(statements.map((sql) => db.query(sql))).then((results) => {
    const failed = results.find((r) => r.status === "rejected");
    if (failed) {
      console.warn(
        "[videos] one or more performance indexes were skipped:",
        failed.reason?.message || failed.reason,
      );
    }
  });
}

/* -------------------- BUNNY TOKEN AUTH (V2) -------------------- */
/**
 * Bunny Token Auth (V2): token = Base64URL( SHA256_RAW( key + path + expires + queryParamsSorted ) )
 * queryParamsSorted must be "form-encoded style" WITHOUT leading "?" and NOT URL-encoded.
 * We use token_path so HLS segments within folder work too.
 */

const BUNNY_ENABLED =
  String(process.env.BUNNY_TOKEN_AUTH_ENABLED || "").toLowerCase() === "true";

const BUNNY_KEY = process.env.BUNNY_TOKEN_AUTH_KEY || "";
const BUNNY_CDN_BASE = process.env.BUNNY_CDN_BASE_URL || "";

function base64UrlNoPad(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\n/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeJoinBaseUrl(base, maybeUrl) {
  if (!maybeUrl) return "";
  const s = String(maybeUrl);
  if (/^https?:\/\//i.test(s)) return s;
  const b = String(base || "").replace(/\/+$/g, "");
  const p = s.startsWith("/") ? s : `/${s}`;
  return `${b}${p}`;
}

function getPathname(u) {
  try {
    const url = new URL(u);
    return url.pathname || "/";
  } catch {
    const s = String(u || "");
    if (!s) return "/";
    return s.startsWith("/") ? s : `/${s}`;
  }
}

function dirnamePath(p) {
  const clean = String(p || "/");
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return "/";
  return clean.slice(0, idx + 1);
}

function bunnySignUrl(inputUrl, { ttlSeconds = 3600, tokenPath = null } = {}) {
  if (!BUNNY_ENABLED || !BUNNY_KEY || !inputUrl) return inputUrl;

  const absolute = safeJoinBaseUrl(BUNNY_CDN_BASE, inputUrl);
  const pathname = getPathname(absolute);

  const expires = Math.floor(Date.now() / 1000) + Math.max(30, ttlSeconds);

  // For HLS, token_path should normally be the video folder so the playlist
  // and every segment/key file under that folder can be requested with the same rule.
  const tp = tokenPath || dirnamePath(pathname);
  const paramData = `token_path=${tp}`;

  const hashable = `${BUNNY_KEY}${pathname}${expires}${paramData}`;
  const sha = crypto.createHash("sha256").update(hashable).digest();
  const token = base64UrlNoPad(sha);

  const signed = new URL(absolute);
  signed.searchParams.set("token", token);
  signed.searchParams.set("expires", String(expires));
  signed.searchParams.set("token_path", tp);

  return signed.toString();
}

function encodeProxyUrl(u) {
  return Buffer.from(String(u || ""), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeProxyUrl(v) {
  const raw = String(v || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  return Buffer.from(raw, "base64").toString("utf8");
}

function isHlsUrl(u) {
  const clean = String(u || "")
    .split("?")[0]
    .split("#")[0];
  return /\.m3u8$/i.test(clean) || clean.includes(".m3u8");
}

function isAllowedPreviewHost(u) {
  try {
    const host = new URL(u).hostname.toLowerCase();
    return (
      host.endsWith(".b-cdn.net") ||
      host === "iframe.mediadelivery.net" ||
      host.endsWith(".mediadelivery.net")
    );
  } catch {
    return false;
  }
}

function cleanBunnyUrl(url) {
  try {
    const clean = new URL(url);
    clean.searchParams.delete("token");
    clean.searchParams.delete("expires");
    clean.searchParams.delete("token_path");
    return clean.toString();
  } catch {
    return url;
  }
}

function getHostNameSafe(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isBunnyStreamHost(u) {
  const host = getHostNameSafe(u);
  return (
    /^vz-\d+\.b-cdn\.net$/i.test(host) || host.endsWith(".mediadelivery.net")
  );
}

function isBunnyStreamRow(row) {
  return (
    String(row?.provider || "").toLowerCase() === "bunny_stream" ||
    !!row?.bunny_video_id ||
    !!row?.bunny_library_id ||
    isBunnyStreamHost(row?.playback_url || row?.video_url || "")
  );
}

function parseMetadataObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function getMigrationSourceUrl(row) {
  const md = parseMetadataObject(row?.metadata);
  return String(
    md?.bunny_stream_migration?.source_url ||
      md?.bunny_stream_migration?.sourceUrl ||
      md?.source_url ||
      "",
  ).trim();
}

function getLoggedOutPreviewSource(row) {
  // Priority for logged-out preview:
  // 1) explicitly uploaded preview/trailer file if available
  // 2) original source file saved during Bunny Stream migration
  // 3) normal video_url for Bunny Storage / MP4 records
  // 4) playback_url only as a last fallback
  //
  // Important: for Bunny Stream migrated videos, playback_url is usually
  // https://vz-<library>.b-cdn.net/<guid>/playlist.m3u8. That URL is often
  // blocked by Bunny Stream Allowed Domains / direct-file rules when used as
  // native HLS. The original migration source is safer for preview gating.
  const explicitPreview = String(
    row?.preview_video_url ||
      row?.preview_url ||
      row?.trailer_url ||
      parseMetadataObject(row?.metadata)?.trailer?.url ||
      "",
  ).trim();
  if (explicitPreview) return explicitPreview;

  const migratedSource = getMigrationSourceUrl(row);
  if (isBunnyStreamRow(row) && migratedSource) return migratedSource;

  const videoUrl = String(row?.video_url || "").trim();
  if (videoUrl && !isBunnyStreamHost(videoUrl)) return videoUrl;

  return String(row?.playback_url || row?.video_url || "").trim();
}

function signPlaybackUrlForRow(row, inputUrl, ttlSeconds) {
  if (!inputUrl) return "";

  // Bunny Stream uses Allowed Domains in this project, not CDN token auth.
  // The BUNNY_TOKEN_AUTH_* env values belong to Bunny Storage. Signing Stream
  // HLS URLs with that key causes 403/unconfigured responses from vz-*.b-cdn.net.
  if (isBunnyStreamRow(row) || isBunnyStreamHost(inputUrl)) {
    return cleanBunnyUrl(inputUrl);
  }

  return bunnySignUrl(inputUrl, {
    ttlSeconds,
    tokenPath: dirnamePath(getPathname(inputUrl)),
  });
}

function normalizeHeaderOrigin(value) {
  try {
    if (!value) return "";
    const u = new URL(String(value));
    return u.origin;
  } catch {
    return "";
  }
}

function getPreviewRequestOrigin(req) {
  const fromOrigin = normalizeHeaderOrigin(req.get("origin"));
  if (fromOrigin) return fromOrigin;

  const fromReferer = normalizeHeaderOrigin(
    req.get("referer") || req.get("referrer"),
  );
  if (fromReferer) return fromReferer;

  return (
    process.env.CLIENT_ORIGIN?.split(",")?.[0] ||
    "https://nolimitsmedia.github.io"
  ).replace(/\/+$/g, "");
}

async function fetchBunnyAsset(
  url,
  { headers = {}, req = null, preferClean = true } = {},
) {
  const requestOrigin = req ? getPreviewRequestOrigin(req) : "";
  const fallbackOrigin = (
    process.env.CLIENT_ORIGIN?.split(",")?.[0] ||
    "https://nolimitsmedia.github.io"
  ).replace(/\/+$/g, "");
  const allowedOrigin = requestOrigin || fallbackOrigin;

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 BishopRobertsonTVPreviewProxy/1.0",
    // Bunny Stream domain rules check the referrer. Do not send a Node Origin
    // header here because it can make Bunny treat the proxy request like a
    // browser CORS request.
    Referer: `${allowedOrigin}/`,
    ...headers,
  };

  const cleanUrl = cleanBunnyUrl(url);

  // For Bunny Stream, request the clean URL only. Do not retry a signed Stream
  // URL because the storage token is not valid for the Stream CDN.
  const attempts = isBunnyStreamHost(cleanUrl)
    ? [cleanUrl]
    : preferClean && cleanUrl !== url
      ? [cleanUrl, url]
      : [url, cleanUrl];

  let lastResp = null;

  for (const attemptUrl of Array.from(new Set(attempts))) {
    const resp = await fetch(attemptUrl, { headers: baseHeaders });
    lastResp = resp;
    if (resp.ok || resp.status === 206) return resp;
    if (![401, 403].includes(resp.status)) return resp;
  }

  return lastResp;
}

async function getPublishedVideoForPreview(videoId) {
  const r = await db.query(
    `
      SELECT
        v.*,
        COALESCE(v.is_premium, TRUE) AS is_premium,
        ${PREVIEW_SECONDS_SQL},
        c.name AS category_name
       FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id
       WHERE v.id = $1
         AND v.is_published = TRUE
       LIMIT 1`,
    [videoId],
  );
  return r.rowCount ? r.rows[0] : null;
}

function rewriteM3u8(text, sourceUrl, videoId, ttlSeconds, row = null) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;

      try {
        const absoluteChild = new URL(trimmed, sourceUrl).toString();
        const playableChild = signPlaybackUrlForRow(
          row,
          absoluteChild,
          ttlSeconds,
        );
        return `/api/videos/public/${videoId}/preview-proxy?u=${encodeProxyUrl(playableChild)}`;
      } catch {
        return line;
      }
    })
    .join("\n");
}

/* -------------------- WATCH PROGRESS (DB RESUME) -------------------- */

let watchProgressTableReady = false;
let watchProgressTablePromise = null;

async function ensureWatchProgressTable() {
  if (watchProgressTableReady) return;
  if (watchProgressTablePromise) return watchProgressTablePromise;

  // Keep this defensive because some dev/prod databases may already have an
  // older watch_progress table that was created before the unique constraint or
  // the newer columns existed. ON CONFLICT(user_id, video_id) requires a unique
  // index, and completed must never be inserted as NULL.
  watchProgressTablePromise = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS watch_progress (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
        position_seconds INTEGER NOT NULL DEFAULT 0,
        duration_seconds INTEGER,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await db.query(
      `ALTER TABLE watch_progress
         ADD COLUMN IF NOT EXISTS position_seconds INTEGER NOT NULL DEFAULT 0,
         ADD COLUMN IF NOT EXISTS duration_seconds INTEGER,
         ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE,
         ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    );

    // Remove older duplicate progress rows before creating the unique index.
    await db.query(`
      DELETE FROM watch_progress a
      USING watch_progress b
      WHERE a.ctid < b.ctid
        AND a.user_id = b.user_id
        AND a.video_id = b.video_id
    `);

    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_progress_user_video_unique
        ON watch_progress (user_id, video_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_watch_progress_user_updated
        ON watch_progress (user_id, updated_at DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_watch_progress_video_updated
        ON watch_progress (video_id, updated_at DESC)
    `);

    watchProgressTableReady = true;
  })().catch((err) => {
    watchProgressTableReady = false;
    watchProgressTablePromise = null;
    throw err;
  });

  return watchProgressTablePromise;
}

function coerceProgressSeconds(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

/* -------------------- PUBLIC ROUTES -------------------- */

router.get("/public/catalog", async (req, res) => {
  try {
    const { search, only_free, limit = 200 } = req.query;

    const params = [];
    let where = `
      WHERE v.is_published = TRUE
        AND v.visibility <> 'unlisted'
    `;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`;
    }

    if (
      String(only_free) === "1" ||
      String(only_free).toLowerCase() === "true"
    ) {
      where += ` AND (v.is_premium = false OR v.is_premium IS NULL)`;
    }

    params.push(Number(limit));
    const sql = `
      SELECT
        v.*,
        COALESCE(v.is_premium, TRUE) AS is_premium,
        ${PREVIEW_SECONDS_SQL},
        c.id   AS category_id,
        c.name AS category_name
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY COALESCE(v.updated_at, v.published_at, v.created_at) DESC
      LIMIT $${params.length}
    `;
    const r = await db.query(sql, params);

    const map = new Map();
    for (const row of r.rows) {
      const key =
        row.category_name ||
        (row.category_id != null ? String(row.category_id) : "Videos");
      const title = row.category_name || "Videos";
      if (!map.has(key)) map.set(key, { title, items: [] });
      map.get(key).items.push(row);
    }

    res.json({
      sections: Array.from(map.values()),
    });
  } catch (e) {
    console.error("[GET /videos/public/catalog] error:", e);
    res.status(500).json({ message: "Failed to fetch catalog" });
  }
});

router.get("/public", async (req, res) => {
  try {
    const { search, category_id, only_free, limit = 50 } = req.query;

    const params = [];
    let where = `
      WHERE v.is_published = TRUE
        AND v.visibility <> 'unlisted'
    `;

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`;
    }
    if (category_id) {
      params.push(category_id);
      where += ` AND v.category_id = $${params.length}`;
    }

    if (
      String(only_free).toLowerCase() === "true" ||
      String(only_free) === "1"
    ) {
      where += ` AND (v.is_premium = false OR v.is_premium IS NULL)`;
    }

    params.push(Number(limit));
    const sql = `
      SELECT
        v.*,
        COALESCE(v.is_premium, TRUE) AS is_premium,
        ${PREVIEW_SECONDS_SQL},
        c.name AS category_name
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY COALESCE(v.published_at, v.created_at) DESC
      LIMIT $${params.length}
    `;
    const r = await db.query(sql, params);

    res.json({ items: r.rows });
  } catch (e) {
    console.error("[GET /videos/public] error:", e);
    res.status(500).json({ message: "Failed to fetch public videos" });
  }
});

router.get("/public/:id", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const r = await db.query(
      `
      SELECT
        v.*,
        COALESCE(v.is_premium, TRUE) AS is_premium,
        ${PREVIEW_SECONDS_SQL},
        c.name AS category_name
       FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id
       WHERE v.id = $1
         AND v.is_published = TRUE
       LIMIT 1`,
      [id],
    );

    if (r.rowCount === 0) {
      return res.status(404).json({ message: "Not found" });
    }

    const row = { ...r.rows[0] };
    const previewSeconds = Number(row.free_preview_seconds || 0);

    if (!row.video_url) {
      row.requires_login = true;
      return res.json(row);
    }

    if (!(previewSeconds > 0)) {
      row.video_url = null;
      row.playback_url = null;
      row.embed_url = null;
      row.requires_login = true;
      return res.json(row);
    }

    const ttl = Math.min(Math.max(previewSeconds + 60, 120), 15 * 60);

    // Logged-out preview must be controllable by our native <video> player.
    // For Bunny Stream migrated videos, do NOT use the Stream HLS URL here when
    // an original migration source exists. Bunny Stream HLS is commonly blocked
    // by Allowed Domains/direct-file rules outside the iframe player.
    const sourceUrl = getLoggedOutPreviewSource(row);

    if (!sourceUrl) {
      row.video_url = null;
      row.playback_url = null;
      row.embed_url = null;
      row.requires_login = true;
      row.preview_mode = "preview_source_missing";
      return res.json(row);
    }

    const playableUrl = signPlaybackUrlForRow(row, sourceUrl, ttl);
    const previewUrl = isHlsUrl(sourceUrl)
      ? `/api/videos/public/${row.id}/preview.m3u8`
      : isAllowedPreviewHost(playableUrl)
        ? `/api/videos/public/${row.id}/preview-proxy?u=${encodeProxyUrl(playableUrl)}`
        : playableUrl;

    row.video_url = previewUrl;
    row.playback_url = previewUrl;
    // Never expose the Bunny Stream iframe to logged-out users unless you have
    // a separate short preview asset. The iframe cannot be reliably stopped by
    // our preview gate JavaScript.
    row.embed_url = null;
    row.requires_login = true;
    row.preview_mode = isHlsUrl(sourceUrl)
      ? "native_hls_preview_proxy"
      : "native_direct_preview";
    row.preview_source_type =
      isBunnyStreamRow(row) && getMigrationSourceUrl(row)
        ? "migration_source"
        : "video_source";
    row.signed_ttl_seconds = ttl;

    return res.json(row);
  } catch (e) {
    console.error("[GET /videos/public/:id] error:", e);
    return res.status(500).json({ message: "Failed to fetch video" });
  }
});

router.get("/public/:id/preview.m3u8", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) return res.status(400).send("Invalid id");

    const row = await getPublishedVideoForPreview(id);
    if (!row) return res.status(404).send("Not found");

    const previewSeconds = Number(row.free_preview_seconds || 0);
    if (!(previewSeconds > 0))
      return res.status(403).send("Preview unavailable");

    const sourceUrl = getLoggedOutPreviewSource(row);
    if (
      !sourceUrl ||
      !isHlsUrl(sourceUrl) ||
      !isAllowedPreviewHost(sourceUrl)
    ) {
      return res.status(400).send("Invalid preview source");
    }

    const ttl = Math.min(Math.max(previewSeconds + 60, 120), 15 * 60);
    const playlistUrl = signPlaybackUrlForRow(row, sourceUrl, ttl);

    const upstream = await fetchBunnyAsset(playlistUrl, {
      req,
      preferClean: true,
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => "");
      console.error(
        "[preview.m3u8] upstream failed",
        upstream.status,
        detail.slice(0, 250),
      );
      return res.status(upstream.status).send("Preview playlist unavailable");
    }

    const playlist = await upstream.text();
    const rewritten = rewriteM3u8(playlist, playlistUrl, id, ttl, row);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-store, max-age=0");
    return res.send(rewritten);
  } catch (e) {
    console.error("[GET /videos/public/:id/preview.m3u8] error:", e);
    return res.status(500).send("Preview playlist failed");
  }
});

router.get("/public/:id/preview-proxy", async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) return res.status(400).send("Invalid id");

    const row = await getPublishedVideoForPreview(id);
    if (!row) return res.status(404).send("Not found");

    const previewSeconds = Number(row.free_preview_seconds || 0);
    if (!(previewSeconds > 0))
      return res.status(403).send("Preview unavailable");

    const target = decodeProxyUrl(req.query.u);
    if (!target || !isAllowedPreviewHost(target)) {
      return res.status(400).send("Invalid preview asset");
    }

    const upstream = await fetchBunnyAsset(target, {
      req,
      preferClean: true,
      headers: req.headers.range ? { Range: req.headers.range } : {},
    });

    if (!upstream.ok && upstream.status !== 206) {
      const detail = await upstream.text().catch(() => "");
      console.error(
        "[preview-proxy] upstream failed",
        upstream.status,
        detail.slice(0, 250),
      );
      return res.status(upstream.status).send("Preview asset unavailable");
    }

    res.status(upstream.status);
    const passthrough = [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
    ];
    for (const h of passthrough) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!res.getHeader("Cache-Control")) {
      res.setHeader("Cache-Control", "public, max-age=300");
    }

    return upstream.body.pipe(res);
  } catch (e) {
    console.error("[GET /videos/public/:id/preview-proxy] error:", e);
    return res.status(500).send("Preview proxy failed");
  }
});

/* -------------------- AUTH’D ROUTES -------------------- */

router.get("/", authenticate, async (req, res) => {
  try {
    ensureVideoListIndexes();

    const {
      search,
      q,
      category_id,
      status = "all",
      sort = "newest",
      sortBy,
      page = 1,
      offset,
      limit = 50,
    } = req.query;

    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const safeOffset = Number.isFinite(Number(offset))
      ? Math.max(0, Number(offset))
      : (safePage - 1) * safeLimit;

    const params = [];
    let where = "WHERE 1=1";

    if (!isAdmin(req.user)) {
      params.push(req.user.id);
      where += ` AND v.created_by = $${params.length}`;
    }

    const term = String(search || q || "").trim();
    if (term) {
      params.push(`%${term}%`);
      where += ` AND (v.title ILIKE $${params.length} OR v.description ILIKE $${params.length})`;
    }
    if (category_id) {
      params.push(category_id);
      where += ` AND v.category_id = $${params.length}`;
    }

    if (String(status).toLowerCase() === "published") {
      where += ` AND v.is_published = TRUE`;
    } else if (String(status).toLowerCase() === "unpublished") {
      where += ` AND (v.is_published = FALSE OR v.is_published IS NULL)`;
    }

    const selectedSort = String(sortBy || sort || "newest").toLowerCase();
    let orderBy =
      "COALESCE(v.published_at, v.updated_at, v.created_at) DESC NULLS LAST, v.id DESC";
    if (selectedSort === "oldest") {
      orderBy =
        "COALESCE(v.published_at, v.updated_at, v.created_at) ASC NULLS LAST, v.id ASC";
    } else if (selectedSort === "title") {
      orderBy = "LOWER(v.title) ASC NULLS LAST, v.id DESC";
    }

    const countSql = `
      SELECT COUNT(*)::int AS total
      FROM videos v
      ${where}
    `;
    const countResult = await db.query(countSql, params);
    const total = Number(countResult.rows?.[0]?.total || 0);

    const dataParams = [...params, safeLimit, safeOffset];
    const sql = `
      SELECT v.*,
             c.name AS category_name,
             COALESCE(v.is_premium, TRUE) AS is_premium,
             ${PREVIEW_SECONDS_SQL}
      FROM videos v
      LEFT JOIN categories c ON c.id = v.category_id
      ${where}
      ORDER BY ${orderBy}
      LIMIT $${dataParams.length - 1}
      OFFSET $${dataParams.length}
    `;
    const r = await db.query(sql, dataParams);

    res.setHeader("Cache-Control", "private, max-age=10");
    res.json({
      items: r.rows,
      total,
      page: safePage,
      limit: safeLimit,
      offset: safeOffset,
      has_more: safeOffset + r.rows.length < total,
    });
  } catch (e) {
    console.error("[GET /videos] error:", e);
    res.status(500).json({ message: "Failed to fetch videos" });
  }
});

router.get("/:id/progress", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ ok: false, message: "Invalid id" });
    }

    await ensureWatchProgressTable();

    const r = await db.query(
      `SELECT position_seconds,
              duration_seconds,
              completed,
              updated_at
         FROM watch_progress
        WHERE user_id = $1
          AND video_id = $2
        LIMIT 1`,
      [String(req.user.id), Number(id)],
    );

    if (r.rowCount === 0) {
      return res.json({
        ok: true,
        video_id: Number(id),
        position_seconds: 0,
        duration_seconds: null,
        completed: false,
        updated_at: null,
      });
    }

    return res.json({ ok: true, video_id: Number(id), ...r.rows[0] });
  } catch (e) {
    console.error("[GET /videos/:id/progress] error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to fetch watch progress" });
  }
});

router.post("/:id/progress", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ ok: false, message: "Invalid id" });
    }

    await ensureWatchProgressTable();

    const position = coerceProgressSeconds(
      req.body?.position_seconds ?? req.body?.position ?? req.body?.seconds,
      0,
    );
    const durationRaw =
      req.body?.duration_seconds ?? req.body?.duration ?? null;
    const duration =
      durationRaw == null ? null : coerceProgressSeconds(durationRaw, 0);

    const completed =
      Boolean(req.body?.completed) ||
      Boolean(
        duration && duration > 0 && position >= Math.max(0, duration - 5),
      );

    const r = await db.query(
      `INSERT INTO watch_progress
         (user_id, video_id, position_seconds, duration_seconds, completed, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id, video_id)
       DO UPDATE SET
         position_seconds = EXCLUDED.position_seconds,
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, watch_progress.duration_seconds),
         completed = EXCLUDED.completed OR watch_progress.completed,
         updated_at = NOW()
       RETURNING position_seconds, duration_seconds, completed, updated_at`,
      [String(req.user.id), Number(id), position, duration, completed],
    );

    return res.json({ ok: true, video_id: Number(id), ...r.rows[0] });
  } catch (e) {
    console.error("[POST /videos/:id/progress] error:", e);
    return res
      .status(500)
      .json({ ok: false, message: "Failed to save watch progress" });
  }
});

router.get("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const r = await db.query(
      `SELECT v.*, 
              c.name AS category_name,
              COALESCE(v.is_premium, TRUE) AS is_premium,
              ${PREVIEW_SECONDS_SQL}
       FROM videos v
       LEFT JOIN categories c ON c.id = v.category_id
       WHERE v.id = $1
       LIMIT 1`,
      [id],
    );

    if (r.rowCount === 0) return res.status(404).json({ message: "Not found" });

    const row = { ...r.rows[0] };
    const ownerOrAdmin =
      isAdmin(req.user) ||
      (row.created_by && String(row.created_by) === String(req.user?.id));

    // ✅ Normal logged-in users are allowed to watch published videos, but they
    // are not allowed to access unpublished/private admin content or edit tools.
    // Admin/owner users can still load any video for the admin details page.
    const isPublished = row.is_published === true;
    const isPublicOrPrivateWatchable = ["public", "private", ""].includes(
      String(row.visibility || "public").toLowerCase(),
    );

    if (!ownerOrAdmin && (!isPublished || !isPublicOrPrivateWatchable)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    if (row.playback_url && !row.video_url) {
      row.video_url = row.playback_url;
    }

    if (row.video_url || row.playback_url) {
      // ✅ Use Stream-safe signing. Bunny Stream URLs must stay clean because
      // BUNNY_TOKEN_AUTH_* belongs to Bunny Storage, not the Stream CDN.
      const ttl = 6 * 3600;
      const sourceUrl = row.playback_url || row.video_url;
      const signedUrl = signPlaybackUrlForRow(row, sourceUrl, ttl);

      row.video_url = signedUrl;
      row.playback_url = signedUrl;
      row.signed_ttl_seconds = ttl;
      row.requires_login = false;
      row.can_manage = ownerOrAdmin;
    }

    res.json(row);
  } catch (e) {
    console.error("[GET /videos/:id] error:", e);
    res.status(500).json({ message: "Failed to fetch video" });
  }
});

router.post("/", authenticate, async (req, res) => {
  try {
    const base = pick(req.body, [
      "title",
      "description",
      "short_description",
      "category_id",
      "thumbnail_url",
      "video_url",
      "preview_video_url",
      "preview_embed_url",
      "preview_bunny_video_id",
      "preview_duration_seconds",
      "visibility",
      "is_premium",
      "free_preview_seconds",
      "is_published",
      "published_at",
      "bunny_video_id",
      "bunny_library_id",
      "provider",
      "provider_key",
      "embed_url",
      "playback_url",
      "processing_status",
    ]);

    if (!base.video_url) {
      return res.status(400).json({ message: "video_url is required" });
    }

    // Bunny Stream upload dedupe:
    // If the browser retries the create-record step after TUS upload succeeds,
    // do not insert a second row for the same Bunny Stream video.
    const incomingBunnyVideoId = String(
      base.bunny_video_id || base.provider_key || "",
    ).trim();

    if (incomingBunnyVideoId) {
      const existing = await db.query(
        `SELECT *
           FROM videos
          WHERE bunny_video_id = $1
             OR provider_key = $1
          ORDER BY id DESC
          LIMIT 1`,
        [incomingBunnyVideoId],
      );

      if (existing.rowCount > 0) {
        return res.json({
          ...existing.rows[0],
          deduped: true,
          duplicate_prevented: true,
        });
      }
    }

    const visibility =
      base.visibility === undefined
        ? "private"
        : normalizeVisibility(base.visibility);
    const is_premium = base.is_premium === undefined ? true : !!base.is_premium;
    const previewSeconds = coerceNonNegInt(base.free_preview_seconds, 0);

    // ✅ FIX: use parseDateInput here too (handles YYYY-MM-DD + ISO safely)
    const is_published =
      base.is_published === undefined ? false : !!base.is_published;

    let published_at = null;
    if (base.published_at !== undefined) {
      const d = parseDateInput(base.published_at);
      if (d === "__invalid__") {
        return res.status(400).json({ message: "Invalid published_at" });
      }
      published_at = d;
    } else {
      published_at = is_published ? new Date() : null;
    }

    let durationSeconds = resolveDurationSeconds(req.body);
    if (durationSeconds == null) {
      durationSeconds = await detectDurationFromUrlMaybeLocal(base.video_url);
    }

    const md = buildMetadataFromBody(req.body);

    const r = await db.query(
      `INSERT INTO videos
       (title, description, short_description, category_id, thumbnail_url, video_url,
        duration_seconds, visibility, is_premium, free_preview_seconds,
        is_published, published_at, metadata, created_by,
        bunny_video_id, bunny_library_id, provider, provider_key, embed_url,
        playback_url, processing_status, preview_video_url, preview_embed_url,
        preview_bunny_video_id, preview_duration_seconds)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       RETURNING *`,
      [
        base.title || null,
        base.description || null,
        base.short_description || null,
        base.category_id || null,
        base.thumbnail_url || null,
        String(base.video_url),
        durationSeconds,
        visibility,
        is_premium,
        previewSeconds,
        is_published,
        published_at,
        JSON.stringify(md),
        req.user?.id || null,
        base.bunny_video_id || null,
        base.bunny_library_id || null,
        base.provider || (base.bunny_video_id ? "bunny_stream" : null),
        base.provider_key || base.bunny_video_id || null,
        base.embed_url || null,
        base.playback_url || base.video_url || null,
        base.processing_status ||
          (base.bunny_video_id ? "processing" : "ready"),
        base.preview_video_url || null,
        base.preview_embed_url || null,
        base.preview_bunny_video_id || null,
        coerceNonNegInt(base.preview_duration_seconds, 0),
      ],
    );

    res.json(r.rows[0]);
  } catch (e) {
    console.error("[POST /videos] error:", e);
    res.status(500).json({ message: "Failed to create video" });
  }
});

router.put("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const perm = await assertOwnerOrAdmin(id, req.user);
    if (!perm.ok) {
      return res.status(perm.status).json({ message: "Forbidden" });
    }

    await db.query("BEGIN");

    const cur = await db.query(
      "SELECT metadata, video_url FROM videos WHERE id=$1 FOR UPDATE",
      [id],
    );
    if (cur.rowCount === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ message: "Not found" });
    }
    const currentMd = cur.rows[0].metadata || {};
    const currentUrl = cur.rows[0].video_url;

    const mdPatch = buildMetadataFromBody(req.body);
    const mergedMd = mergeJson(currentMd, mdPatch);

    const base = pick(req.body, [
      "title",
      "description",
      "short_description",
      "category_id",
      "thumbnail_url",
      "video_url",
      "preview_video_url",
      "preview_embed_url",
      "preview_bunny_video_id",
      "preview_duration_seconds",
      "visibility",
      "is_premium",
      "free_preview_seconds",
      "is_published",
      "published_at",
      "bunny_video_id",
      "bunny_library_id",
      "provider",
      "provider_key",
      "embed_url",
      "playback_url",
      "processing_status",
    ]);

    const sets = [];
    const vals = [];
    let i = 1;

    for (const [k, v] of Object.entries(base)) {
      if (k === "visibility") {
        sets.push(`${k} = $${i++}`);
        vals.push(normalizeVisibility(v));
      } else if (k === "is_premium") {
        sets.push(`${k} = $${i++}`);
        vals.push(!!v);
      } else if (k === "free_preview_seconds") {
        sets.push(`${k} = $${i++}`);
        vals.push(coerceNonNegInt(v, 0));
      } else if (k === "is_published") {
        sets.push(`${k} = $${i++}`);
        vals.push(!!v);
      } else if (k === "published_at") {
        const d = parseDateInput(v);
        if (d === "__invalid__") {
          await db.query("ROLLBACK");
          return res.status(400).json({ message: "Invalid published_at" });
        }
        sets.push(`${k} = $${i++}`);
        vals.push(d);
      } else {
        sets.push(`${k} = $${i++}`);
        vals.push(v === undefined ? null : v);
      }
    }

    let maybeDur = resolveDurationSeconds(req.body);
    if (maybeDur == null) {
      const newUrl = base.video_url !== undefined ? base.video_url : currentUrl;
      maybeDur = await detectDurationFromUrlMaybeLocal(newUrl);
    }
    if (maybeDur != null) {
      sets.push(`duration_seconds = $${i++}`);
      vals.push(maybeDur);
    }

    sets.push(`metadata = $${i++}`);
    vals.push(JSON.stringify(mergedMd));

    vals.push(id);

    const sql = `UPDATE videos SET ${sets.join(
      ", ",
    )} WHERE id = $${i} RETURNING *`;

    const r = await db.query(sql, vals);

    await db.query("COMMIT");
    return res.json(r.rows[0]);
  } catch (e) {
    console.error("[PUT /videos/:id] error:", e);
    try {
      await db.query("ROLLBACK");
    } catch {}
    return res.status(500).json({ message: "Failed to update video" });
  }
});

router.post("/:id/publish", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const perm = await assertOwnerOrAdmin(id, req.user);
    if (!perm.ok) {
      return res.status(perm.status).json({ message: "Forbidden" });
    }

    // ✅ FIX: allow client to pass published_at (optional) so Publish won't overwrite chosen date.
    // If provided, we validate and persist it. If not provided, keep old behavior.
    let setPublishedAtSql = "published_at = COALESCE(published_at, NOW())";
    const vals = [id];
    const incoming = req.body?.published_at;

    if (incoming !== undefined) {
      const d = parseDateInput(incoming);
      if (d === "__invalid__") {
        return res.status(400).json({ message: "Invalid published_at" });
      }
      // if null => clear; else set to provided date/time
      vals.push(d);
      setPublishedAtSql = "published_at = COALESCE($2, NOW())";
      // NOTE: If caller sends a real Date, COALESCE($2, NOW()) becomes that date.
      // If caller sends null, COALESCE(null, NOW()) becomes now (publish moment).
      // This keeps "Publish with no date" working naturally while supporting a chosen date.
    }

    const { rows } = await db.query(
      `UPDATE videos
       SET is_published = TRUE,
           ${setPublishedAtSql}
       WHERE id = $1
       RETURNING id, title, created_by`,
      vals,
    );
    if (!rows.length) {
      return res.status(404).json({ message: "Not found" });
    }

    const video = rows[0];
    const videoId = Number(video.id);
    const uploaderId = video.created_by || null;

    const title = "New video published";
    const body = video.title || "A new video is available";

    const appPayload = {
      type: "video_published",
      video_id: videoId,
      route: `/watch/${videoId}`,
    };

    try {
      await db.query(
        `
        INSERT INTO notifications (user_id, title, body, channel, payload)
        SELECT
          u.id,
          $1::text,
          $2::text,
          'video_published'::text,
          jsonb_build_object(
            'type', 'video_published',
            'video_id', $3::int,
            'route', $4::text
          )
        FROM users u
        WHERE u.id IS NOT NULL
          AND ($5::int IS NULL OR u.id <> $5)
      `,
        [title, body, videoId, `/watch/${videoId}`, uploaderId],
      );
    } catch (err) {
      console.warn(
        "[notifications] insert on publish failed:",
        err?.message || err,
      );
    }

    try {
      const t = await db.query(
        `
        SELECT token
        FROM user_push_tokens
        WHERE token IS NOT NULL
          AND token <> ''
          AND ($1::int IS NULL OR user_id <> $1)
      `,
        [uploaderId],
      );
      const tokens = t.rows.map((r) => r.token).filter(Boolean);

      if (tokens.length) {
        await sendPush(tokens, {
          title,
          body,
          data: appPayload,
        });
      }
    } catch (e) {
      console.warn("[FCM] publish notification skipped:", e?.message || e);
    }

    res.json(video);
  } catch (e) {
    console.error("[POST /videos/:id/publish] error:", e);
    res.status(500).json({ message: "Failed to publish video" });
  }
});

router.post("/:id/unpublish", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) return res.status(400).json({ message: "Invalid id" });

    const perm = await assertOwnerOrAdmin(id, req.user);
    if (!perm.ok) return res.status(perm.status).json({ message: "Forbidden" });

    const { rows } = await db.query(
      `UPDATE videos
       SET is_published = FALSE
       WHERE id = $1
       RETURNING *`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ message: "Not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error("[POST /videos/:id/unpublish] error:", e);
    res.status(500).json({ message: "Failed to unpublish video" });
  }
});

router.delete("/:id", authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) return res.status(400).json({ message: "Invalid id" });

    const perm = await assertOwnerOrAdmin(id, req.user);
    if (!perm.ok) return res.status(perm.status).json({ message: "Forbidden" });

    await db.query("DELETE FROM videos WHERE id=$1", [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /videos/:id] error:", e);
    res.status(500).json({ message: "Failed to delete video" });
  }
});

router.get("/:id/playlists", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isDigits(id)) return res.status(400).json({ message: "Invalid id" });

    const q = `
      SELECT p.*
      FROM playlist_videos pv
      JOIN playlists p ON p.id = pv.playlist_id
      WHERE pv.video_id = $1
      ORDER BY COALESCE(pv.sort_index, 999999), pv.added_at DESC
    `;
    const { rows } = await db.query(q, [id]);
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});

router.get("/:id/status", authenticate, async (req, res) => {
  const { id } = req.params;
  const q = await db.query(
    `SELECT id, processing_status, processing_error, processing_updated_at,
            provider, bunny_video_id, bunny_library_id
     FROM videos
     WHERE id=$1`,
    [id],
  );
  if (!q.rows[0]) return res.status(404).json({ message: "Not found" });

  // Bunny Stream transcoding happens asynchronously on Bunny.
  // Until a webhook/status sync is added, keep the local status but expose provider IDs.
  res.json(q.rows[0]);
});

module.exports = router;
