// server-api/scripts/backfillVideoDurations.js
const path = require("path");
const fs = require("fs");

// --- Load .env BEFORE requiring db
(function loadEnv() {
  const cands = [
    path.join(__dirname, "..", ".env"),
    path.join(__dirname, "..", "..", ".env"),
  ];
  for (const p of cands) {
    if (fs.existsSync(p)) {
      require("dotenv").config({ path: p });
      console.log(`[dotenv] loaded ${p}`);
      break;
    }
  }
})();

const db = require("../db"); // env loaded first

// Optional fetch (Node 18+ has global.fetch)
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("node-fetch");
  } catch {}
}

let ffprobePath = null;
let execa = null;
try {
  ({ execa } = require("execa"));
  ffprobePath = require("ffprobe-static").path;
} catch {
  /* ok */
}

// ---- music-metadata loader (handles CommonJS + ESM)
let mmParseFile = null;
async function ensureMusicMetadata() {
  if (mmParseFile) return mmParseFile;
  try {
    // Preferred CommonJS subpath export
    mmParseFile = require("music-metadata/lib/core").parseFile;
    return mmParseFile;
  } catch {
    // ESM fallback (Node 14+)
    try {
      const mod = await import("music-metadata");
      mmParseFile = mod.parseFile;
      return mmParseFile;
    } catch {
      return null;
    }
  }
}

const VERBOSE = process.argv.includes("--verbose");
function log(...a) {
  if (VERBOSE) console.log(...a);
}

const hasWasabi =
  !!process.env.WASABI_ENDPOINT &&
  !!process.env.WASABI_BUCKET &&
  !!process.env.WASABI_ACCESS_KEY &&
  !!process.env.WASABI_SECRET_KEY;

let S3Client, GetObjectCommand, s3;
if (hasWasabi) {
  try {
    ({ S3Client, GetObjectCommand } = require("@aws-sdk/client-s3"));
    s3 = new S3Client({
      region: "us-east-1",
      endpoint: process.env.WASABI_ENDPOINT,
      credentials: {
        accessKeyId: process.env.WASABI_ACCESS_KEY,
        secretAccessKey: process.env.WASABI_SECRET_KEY,
      },
      forcePathStyle: true,
    });
  } catch (e) {
    console.warn(
      "[backfill] @aws-sdk/client-s3 not installed; Wasabi fallback disabled"
    );
  }
}

function isHttp(u = "") {
  return /^https?:\/\//i.test(u);
}
function isM3U8(u = "") {
  return /\.m3u8(\?|$)/i.test(u);
}

async function preflightFfprobe() {
  if (!ffprobePath || !execa) return false;
  try {
    const r = await execa(ffprobePath, ["-version"], {
      windowsHide: true,
      shell: process.platform === "win32",
    });
    log("[ffprobe ok]", r.stdout.split("\n")[0]);
    return true;
  } catch (e) {
    console.warn("[ffprobe not runnable]", e.message || e);
    return false;
  }
}

async function probeSecondsFFprobe(inputPathOrUrl) {
  if (!ffprobePath || !execa) return 0;
  const args = [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    "-i",
    inputPathOrUrl, // -i is more robust on Windows
  ];
  try {
    const { stdout } = await execa(ffprobePath, args, {
      windowsHide: true,
      shell: process.platform === "win32",
    });
    const meta = JSON.parse(stdout);
    const dur = Number(meta?.format?.duration || 0);
    return Number.isFinite(dur) ? Math.round(dur) : 0;
  } catch (e) {
    log("[ffprobe error]", e.shortMessage || e.message || String(e));
    return 0;
  }
}

async function probeSecondsMusicMetadata(localPath) {
  try {
    const stat = fs.statSync(localPath);
    if (!stat.isFile() || stat.size === 0) {
      log("[mm] not a file or empty:", localPath);
      return 0;
    }
    const parseFile = await ensureMusicMetadata();
    if (!parseFile) return 0;
    const meta = await parseFile(localPath, { duration: true });
    const dur = Number(meta?.format?.duration || 0); // seconds (float)
    const secs = Math.round(dur);
    if (secs > 0) log("[mm ok]", localPath, `${secs}s`);
    return secs > 0 ? secs : 0;
  } catch (e) {
    log("[mm error]", e.message || e);
    return 0;
  }
}

async function probeSecondsFromM3U8(url) {
  if (!fetchFn) return 0;
  try {
    const res = await fetchFn(url);
    if (!res.ok) {
      log("[m3u8] HTTP", res.status, url);
      return 0;
    }
    const text = await res.text();
    const secs = text
      .split("\n")
      .filter((l) => l.startsWith("#EXTINF:"))
      .reduce((s, l) => s + parseFloat(l.slice(8)), 0);
    const rounded = Math.round(secs || 0);
    if (rounded > 0) log("[m3u8 ok]", `${rounded}s`);
    return rounded;
  } catch (e) {
    log("[m3u8 fetch error]", e.message || e);
    return 0;
  }
}

function candidateLocalPaths(videoUrl) {
  const base = path.basename(videoUrl || "");
  const guesses = [
    path.join(__dirname, "..", "uploads", base), // /uploads/<file>
    path.join(__dirname, "..", "public", "uploads", base), // /public/uploads/<file>
    path.join(__dirname, "..", "uploads", "videos", base), // /uploads/videos/<file>
  ];
  return guesses.filter((p) => fs.existsSync(p));
}

function deriveWasabiKeyFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.replace(/^\/+/, "").split("/");
    if (!parts.length) return null;
    if (parts[0] === process.env.WASABI_BUCKET) {
      return parts.slice(1).join("/");
    }
    return null;
  } catch {
    return null;
  }
}

async function downloadFromWasabiToTemp(key) {
  if (!s3 || !GetObjectCommand) return null;
  try {
    const cmd = new GetObjectCommand({
      Bucket: process.env.WASABI_BUCKET,
      Key: key,
    });
    const resp = await s3.send(cmd);
    const tmp = path.join(__dirname, "..", "tmp_uploads");
    if (!fs.existsSync(tmp)) fs.mkdirSync(tmp, { recursive: true });
    const out = path.join(
      tmp,
      `probe-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}-${path.basename(key)}`
    );
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(out);
      resp.Body.pipe(ws);
      resp.Body.on("error", reject);
      ws.on("finish", resolve);
      ws.on("error", reject);
    });
    return out;
  } catch (e) {
    log("[wasabi getObject error]", e.message || e);
    return null;
  }
}

function isHttpUrlOrLocal(u) {
  return isHttp(u) || u.startsWith("/");
}
function isHttp(u = "") {
  return /^https?:\/\//i.test(u);
}
function isM3U8(u = "") {
  return /\.m3u8(\?|$)/i.test(u);
}

async function probeSeconds(videoUrl) {
  const url = String(videoUrl || "");

  // 1) HLS playlists
  if (isM3U8(url)) {
    const s = await probeSecondsFromM3U8(url);
    if (s > 0) return s;
  }

  // 2) Local files (various common folders)
  const locals = candidateLocalPaths(url);
  for (const p of locals) {
    const abs = path.resolve(p);
    // Try ffprobe first
    let s = await probeSecondsFFprobe(abs);
    if (s > 0) {
      log("[local ffprobe ok]", abs);
      return s;
    }
    // Fallback: pure JS parser (no binaries)
    s = await probeSecondsMusicMetadata(abs);
    if (s > 0) {
      return s;
    }
  }
  if (locals.length) log("[local tried but failed]", locals);

  // 3) Public HTTP(S) — ffprobe can read URLs directly
  if (isHttp(url)) {
    const s = await probeSecondsFFprobe(url);
    if (s > 0) {
      log("[remote ffprobe ok]", url);
      return s;
    }

    // 3b) Wasabi fallback via SDK if URL matches bucket but isn’t public
    if (hasWasabi && url.includes(process.env.WASABI_BUCKET)) {
      const key = deriveWasabiKeyFromUrl(url);
      if (key) {
        const tempPath = await downloadFromWasabiToTemp(key);
        if (tempPath) {
          let s2 = await probeSecondsFFprobe(tempPath);
          if (s2 <= 0) s2 = await probeSecondsMusicMetadata(tempPath);
          try {
            fs.unlinkSync(tempPath);
          } catch {}
          if (s2 > 0) {
            log("[wasabi ok]", key, `${s2}s`);
            return s2;
          }
        }
      }
    }
  }

  // 4) Last resort: nothing worked
  log("[probe failed]", url);
  return 0;
}

(async () => {
  try {
    await preflightFfprobe();

    const q = await db.query(
      `SELECT id, video_url, COALESCE(duration_seconds,0) AS duration_seconds
         FROM videos
        WHERE COALESCE(duration_seconds,0)=0
        ORDER BY id DESC
        LIMIT 500`
    );

    if (q.rowCount === 0) {
      console.log("Nothing to backfill. All videos already have durations.");
      process.exit(0);
      return;
    }

    console.log(
      `Backfilling ${q.rowCount} video(s)… (use --verbose for details)`
    );
    let updated = 0;

    for (const row of q.rows) {
      const url = row.video_url || "";
      const secs = await probeSeconds(url);
      if (secs > 0) {
        await db.query("UPDATE videos SET duration_seconds=$1 WHERE id=$2", [
          secs,
          row.id,
        ]);
        updated++;
        console.log(`✓ id=${row.id} ${secs}s`);
      } else {
        console.log(`… id=${row.id} (could not detect)`);
      }
    }

    console.log(`Done. Updated ${updated}/${q.rowCount}.`);
    process.exit(0);
  } catch (e) {
    console.error("Backfill failed:", e);
    process.exit(1);
  }
})();
