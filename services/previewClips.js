// server-api/services/previewClips.js
//
// Release 2.3 Part B — real preview clips.
// For each premium video with a free preview, cut the first N seconds of the
// ORIGINAL file (Wasabi) into a short clip and upload it to Bunny Stream as its
// own video. Signed-out visitors then only ever receive the clip — never the
// full message (see routes/videos.js, signed-out shaping).
//
// - No re-encoding: ffmpeg copies the first N seconds (fast, same quality, and
//   only the start of the file is downloaded).
// - Clips go to the same Bunny library (so MediaCage DRM protects them too), in
//   a "Preview clips" collection, titled "Preview · <title>".
// - One clip at a time (queue). Status per video in metadata.preview_clip.
// - PREVIEW_CLIPS_AUTO=true: new/missing clips are made automatically.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const fetch = require("node-fetch");
const db = require("../db");

const MAX_SECONDS = 15 * 60;
const SOURCE_KEY_SQL =
  "COALESCE(NULLIF(v.wasabi_key, ''), v.metadata->'wasabi_import'->>'key')";

function cfg() {
  return {
    libraryId: String(process.env.BUNNY_STREAM_LIBRARY_ID || "").trim(),
    apiKey: String(process.env.BUNNY_STREAM_API_KEY || "").trim(),
    apiBase: String(
      process.env.BUNNY_STREAM_API_BASE || "https://video.bunnycdn.com",
    ).replace(/\/+$/, ""),
    collectionName: String(
      process.env.PREVIEW_CLIPS_COLLECTION || "Preview clips",
    ),
  };
}

// ---------- source: the original file in Wasabi ----------
let signer = null; // replaceable in tests
async function signWasabi(bucket, key) {
  if (signer) return signer(bucket, key);
  const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const s3 = new S3Client({
    region: process.env.WASABI_REGION || "us-east-1",
    endpoint: process.env.WASABI_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId:
        process.env.WASABI_ACCESS_KEY_ID || process.env.WASABI_ACCESS_KEY,
      secretAccessKey:
        process.env.WASABI_SECRET_ACCESS_KEY || process.env.WASABI_SECRET_KEY,
    },
  });
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 2 * 60 * 60,
  });
}

function sourceOf(row) {
  const meta = row.metadata || {};
  const key = row.wasabi_key || meta.wasabi_import?.key || "";
  const bucket =
    row.wasabi_bucket ||
    meta.wasabi_import?.bucket ||
    process.env.WASABI_BUCKET ||
    "";
  return key && bucket ? { bucket, key } : null;
}

// ---------- cutting ----------
function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

function cutClip(srcUrl, seconds, outPath) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "0",
      "-i",
      srcUrl,
      "-t",
      String(seconds),
      "-map",
      "0:v:0?",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outPath,
    ];
    const p = spawn(ffmpegPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    p.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => p.kill("SIGKILL"), 15 * 60 * 1000);
    p.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`Video tool could not start: ${e.message}`));
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (
        code === 0 &&
        fs.existsSync(outPath) &&
        fs.statSync(outPath).size > 1024
      )
        resolve();
      else
        reject(
          new Error(
            `Cutting failed${err ? `: ${err.trim().split("\n").pop()}` : ""}`,
          ),
        );
    });
  });
}

// ---------- Bunny ----------
async function bunny(
  pathname,
  { method = "GET", json, body, headers = {} } = {},
) {
  const { apiBase, apiKey } = cfg();
  const resp = await fetch(`${apiBase}${pathname}`, {
    method,
    headers: {
      AccessKey: apiKey,
      Accept: "application/json",
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!resp.ok)
    throw new Error(
      `Bunny ${method} ${pathname.split("?")[0]}: ${resp.status} ${data?.message || data?.raw || ""}`.trim(),
    );
  return data;
}

let collectionIdCache = null;
async function previewCollectionId() {
  if (collectionIdCache) return collectionIdCache;
  const { libraryId, collectionName } = cfg();
  try {
    const list = await bunny(
      `/library/${libraryId}/collections?page=1&itemsPerPage=100&search=${encodeURIComponent(collectionName)}`,
    );
    const hit = (list?.items || []).find((c) => c.name === collectionName);
    if (hit?.guid) return (collectionIdCache = hit.guid);
    const made = await bunny(`/library/${libraryId}/collections`, {
      method: "POST",
      json: { name: collectionName },
    });
    return (collectionIdCache = made?.guid || null);
  } catch {
    return null; // clips still work without the collection
  }
}

async function uploadClip(title, filePath) {
  const { libraryId } = cfg();
  const collectionId = await previewCollectionId();
  const created = await bunny(`/library/${libraryId}/videos`, {
    method: "POST",
    json: {
      title: `Preview · ${String(title || "Untitled").slice(0, 180)}`,
      ...(collectionId ? { collectionId } : {}),
    },
  });
  const guid = created?.guid;
  if (!guid) throw new Error("Bunny did not return the new clip's id");
  const size = fs.statSync(filePath).size;
  await bunny(`/library/${libraryId}/videos/${guid}`, {
    method: "PUT",
    body: fs.createReadStream(filePath),
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(size),
    },
  });
  return guid;
}

async function deleteClip(guid) {
  const { libraryId } = cfg();
  if (!guid) return;
  try {
    await bunny(`/library/${libraryId}/videos/${guid}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[preview clips] old clip not deleted:", e.message);
  }
}

// ---------- one video ----------
async function setClipStatus(id, patch) {
  await db.query(
    `UPDATE videos SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{preview_clip}',
       COALESCE(metadata->'preview_clip', '{}'::jsonb) || $2::jsonb, true) WHERE id = $1`,
    [id, JSON.stringify({ ...patch, updated_at: new Date().toISOString() })],
  );
}

async function makeClip(videoId) {
  const { libraryId, apiKey } = cfg();
  if (!libraryId || !apiKey)
    throw new Error(
      "Bunny Stream is not configured (BUNNY_STREAM_LIBRARY_ID / BUNNY_STREAM_API_KEY)",
    );
  const { rows } = await db.query("SELECT * FROM videos WHERE id = $1", [
    videoId,
  ]);
  const row = rows[0];
  if (!row) throw new Error("Video not found");
  const seconds = Math.min(
    MAX_SECONDS,
    Math.floor(Number(row.free_preview_seconds) || 0),
  );
  if (!(seconds > 0)) throw new Error("This video has no free preview length");
  const src = sourceOf(row);
  if (!src) throw new Error("No original file (Wasabi) for this video");
  await setClipStatus(videoId, { status: "processing", error: null });
  const out = path.join(os.tmpdir(), `preview-${videoId}-${Date.now()}.mp4`);
  try {
    await cutClip(await signWasabi(src.bucket, src.key), seconds, out);
    const guid = await uploadClip(row.title, out);
    const old = row.preview_bunny_video_id;
    await db.query(
      "UPDATE videos SET preview_bunny_video_id = $2, preview_duration_seconds = $3 WHERE id = $1",
      [videoId, guid, seconds],
    );
    await setClipStatus(videoId, {
      status: "ready",
      error: null,
      bunny_video_id: guid,
      seconds,
      made_at: new Date().toISOString(),
    });
    if (old && old !== guid) await deleteClip(old);
    return { guid, seconds };
  } catch (e) {
    await setClipStatus(videoId, {
      status: "failed",
      error: String(e.message || e).slice(0, 300),
    });
    throw e;
  } finally {
    fs.promises.unlink(out).catch(() => {});
  }
}

// ---------- queue (one at a time) ----------
const queue = [];
let current = null;
async function drain() {
  if (current) return;
  while (queue.length) {
    current = queue.shift();
    try {
      await makeClip(current);
    } catch (e) {
      console.warn(`[preview clips] video ${current}: ${e.message}`);
    }
  }
  current = null;
}
async function enqueue(ids) {
  let added = 0;
  for (const id of ids) {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || n === current || queue.includes(n))
      continue;
    queue.push(n);
    added += 1;
    await setClipStatus(n, { status: "queued", error: null }).catch(() => {});
  }
  drain();
  return added;
}
const queueState = () => ({ current, waiting: queue.length });
async function idle() {
  while (current || queue.length) await new Promise((r) => setTimeout(r, 50));
}

// ---------- lists ----------
// Videos that should have a clip: published, a free preview, and an original file.
async function list() {
  const { rows } = await db.query(
    `SELECT v.id, v.title, v.free_preview_seconds, v.preview_bunny_video_id, v.preview_duration_seconds,
            v.metadata->'preview_clip' AS clip, v.published_at
       FROM videos v
      WHERE v.is_published = TRUE AND COALESCE(v.free_preview_seconds, 0) > 0 AND ${SOURCE_KEY_SQL} IS NOT NULL
      ORDER BY v.published_at DESC NULLS LAST, v.id DESC
      LIMIT 2000`,
  );
  return rows.map((r) => {
    const want = Math.min(
      MAX_SECONDS,
      Math.floor(Number(r.free_preview_seconds) || 0),
    );
    const clip = r.clip || {};
    let status = "missing";
    if (current === r.id) status = "processing";
    else if (queue.includes(r.id)) status = "queued";
    else if (r.preview_bunny_video_id)
      status =
        Number(r.preview_duration_seconds) === want ? "ready" : "outdated";
    else if (clip.status === "failed") status = "failed";
    return {
      id: r.id,
      title: r.title,
      preview_seconds: want,
      status,
      clip_seconds: r.preview_duration_seconds,
      error: status === "failed" ? clip.error || "" : "",
      made_at: clip.made_at || null,
    };
  });
}

function startAutoWorker() {
  if (String(process.env.PREVIEW_CLIPS_AUTO || "").toLowerCase() !== "true")
    return null;
  const tick = async () => {
    try {
      const todo = (await list())
        .filter((v) => v.status === "missing" || v.status === "outdated")
        .slice(0, 10);
      if (todo.length) await enqueue(todo.map((v) => v.id));
    } catch (e) {
      if (String(e?.code) !== "42P01")
        console.warn("[preview clips] auto run failed:", e.message);
    }
  };
  const t = setInterval(tick, 15 * 60 * 1000);
  t.unref?.();
  setTimeout(tick, 60 * 1000).unref?.();
  return t;
}

module.exports = {
  makeClip,
  enqueue,
  list,
  queueState,
  idle,
  startAutoWorker,
  cutClip,
  sourceOf,
  _setSigner: (fn) => {
    signer = fn;
  },
  _resetCollection: () => {
    collectionIdCache = null;
  },
};
