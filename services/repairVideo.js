// server-api/services/repairVideo.js — "Quick repair" for files Bunny cannot encode
//
// Rebuilds the file's timing and index and rewrites ONLY the sound as standard
// AAC stereo; the picture is copied as is (no quality loss, fast, light on the
// server). Fixes most "Transcoding failed" files (odd audio formats, broken
// timestamps, an index at the end of the file). Reads the original straight
// from its (signed) link and writes a temporary MP4 that the caller uploads.
const { spawn } = require("child_process");

function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

const toSeconds = (hms) => {
  const m = String(hms || "").match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

function stoppedMessage(signal) {
  if (signal === "SIGKILL")
    return "The server stopped the video tool (SIGKILL) — usually because it ran out of memory. Try again when the site is quiet.";
  return `The video tool crashed (${signal || "no exit code"}). The file may be damaged, or the server’s video tool cannot handle it — convert the file on a computer (HandBrake, “Fast 1080p30”, MP4) and use “Choose new file”.`;
}

const webInput = (u) =>
  /^https?:\/\//i.test(String(u))
    ? [
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_delay_max",
        "10",
      ]
    : [];
const AUDIO_AAC = ["-c:a", "aac", "-b:a", "160k", "-ac", "2", "-ar", "48000"];

// Quick repair. attempt 1: rebuild timing/index, sound to AAC, picture copied.
// attempt 2: also ignore the file's own (broken) decoding timestamps.
// onProgress(percent 0–100)
function quickRepair(
  inputUrl,
  outFile,
  onProgress = () => {},
  { attempt = 1 } = {},
) {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-threads",
    "1",
    "-probesize",
    "20M",
    "-analyzeduration",
    "20M",
    ...webInput(inputUrl),
    "-fflags",
    attempt >= 2 ? "+genpts+igndts+discardcorrupt" : "+genpts+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-i",
    inputUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    ...AUDIO_AAC,
    "-avoid_negative_ts",
    "make_zero",
    "-max_muxing_queue_size",
    "1024",
    "-movflags",
    "+faststart",
    outFile,
  ];
  return runFfmpeg(args, 0, onProgress, "repaired");
}

// Full conversion (like HandBrake "Fast 1080p30"): the picture is re-encoded
// as standard H.264 at a steady frame rate (max 1080p), sound as AAC. Slow —
// roughly the length of the video or more on a small server — and kept light
// on memory (one thread, short look-ahead).
function fullConvert(inputUrl, outFile, onProgress = () => {}) {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-threads",
    "1",
    "-probesize",
    "20M",
    "-analyzeduration",
    "20M",
    ...webInput(inputUrl),
    "-fflags",
    "+genpts+igndts+discardcorrupt",
    "-err_detect",
    "ignore_err",
    "-i",
    inputUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    "scale='min(1920,iw)':-2",
    "-fps_mode",
    "cfr",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    "-x264-params",
    "rc-lookahead=10:threads=1",
    ...AUDIO_AAC,
    "-max_muxing_queue_size",
    "1024",
    "-movflags",
    "+faststart",
    outFile,
  ];
  return runFfmpeg(args, 0, onProgress, "converted");
}

// Trim: keep only the part from `start` to `end` (seconds). The picture is
// copied (no re-encode, no quality loss), so the cut lands on the nearest
// keyframe at or before `start` (usually within a second or two); the sound is
// rewritten as AAC so any audio format works in MP4.
function trimFile(inputUrl, outFile, start, end, onProgress = () => {}) {
  const from = Math.max(0, Number(start) || 0);
  const length = Math.max(1, Number(end) - from);
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    "-threads",
    "1",
    "-probesize",
    "20M",
    "-analyzeduration",
    "20M",
    ...(/^https?:\/\//i.test(String(inputUrl))
      ? [
          "-reconnect",
          "1",
          "-reconnect_streamed",
          "1",
          "-reconnect_delay_max",
          "10",
        ]
      : []),
    "-ss",
    String(from),
    "-i",
    inputUrl,
    "-t",
    String(length),
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-avoid_negative_ts",
    "make_zero",
    "-max_muxing_queue_size",
    "1024",
    "-movflags",
    "+faststart",
    outFile,
  ];
  return runFfmpeg(args, length, onProgress, "cut");
}

// the line that explains a failure (ffmpeg ends with generic lines such as
// "Conversion failed!" or "N frames left in the queue on closing")
function reasonFrom(tail) {
  const lines = String(tail)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const noise =
    /frames left in the queue|^Conversion failed|^Exiting normally|^video:|^\[out#|^Press \[q\]/i;
  const hit = lines.find(
    (l) =>
      !noise.test(l) &&
      /error|invalid|failed|could not|not supported|unsupported|non[- ]monoton|corrupt|truncated|no such|unable|missing/i.test(
        l,
      ),
  );
  return (hit || lines.filter((l) => !noise.test(l)).pop() || "")
    .replace(/^\[[^\]]+\]\s*/, "")
    .slice(0, 240);
}

// shared runner: progress from "time=", clear messages when stopped
function runFfmpeg(args, totalSeconds, onProgress, verb) {
  return new Promise((resolve, reject) => {
    let tail = "";
    let errors = "";
    let total = Number(totalSeconds) || 0;
    const p = spawn(ffmpegPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr.on("data", (buf) => {
      const t = buf.toString();
      tail = (tail + t).slice(-6000);
      // keep error lines even when lots of progress output follows
      for (const l of t.split(/\r?\n/))
        if (/error|invalid|failed|non[- ]monoton|corrupt|unsupported/i.test(l))
          errors = (errors + l + "\n").slice(-3000);
      if (!total) {
        const d = t.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
        if (d) total = toSeconds(d[1]);
      }
      const times = [...t.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
      if (total && times.length)
        onProgress(
          Math.min(
            99,
            Math.round((toSeconds(times[times.length - 1][1]) / total) * 100),
          ),
        );
    });
    p.on("error", (e) =>
      reject(
        new Error(`The video tool could not start (${e.code || e.message}).`),
      ),
    );
    p.on("close", (code, signal) => {
      if (signal || code === null) {
        const err = new Error(stoppedMessage(signal));
        err.crashed = true;
        reject(err);
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve({ duration: total });
      } else {
        const why = reasonFrom(`${errors}\n${tail}`);
        reject(
          new Error(
            `The file could not be ${verb}${why ? `: ${why}` : ` (ffmpeg exit ${code})`}.`,
          ),
        );
      }
    });
  });
}

// Download a (signed) web address to a local file first: the static ffmpeg
// build used on Render can crash (SIGSEGV) when it opens web addresses itself
// (name lookups in static builds), so ffmpeg only ever reads local files.
async function downloadToFile(url, filePath, onProgress = () => {}) {
  const fs = require("fs");
  const fetch = require("node-fetch");
  const r = await fetch(url, { timeout: 0 });
  if (!r.ok)
    throw new Error(`The original file could not be downloaded (${r.status}).`);
  const total = Number(r.headers.get("content-length")) || 0;
  let got = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    r.body.on("data", (chunk) => {
      got += chunk.length;
      if (total) onProgress(Math.min(99, Math.round((got / total) * 100)));
    });
    r.body.on("error", reject);
    out.on("error", (e) =>
      reject(
        e.code === "ENOSPC"
          ? new Error("The server ran out of disk space for this file.")
          : e,
      ),
    );
    out.on("finish", resolve);
    r.body.pipe(out);
  });
  if (total && got < total)
    throw new Error(
      "The download of the original file was cut off. Try again.",
    );
  onProgress(100);
  return got;
}

module.exports = {
  quickRepair,
  fullConvert,
  trimFile,
  downloadToFile,
  ffmpegPath,
  reasonFrom,
};
