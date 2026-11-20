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

// onProgress(percent 0–100)
function quickRepair(inputUrl, outFile, onProgress = () => {}) {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-y",
    // small servers (Render 512 MB): one thread, small read-ahead
    "-threads",
    "1",
    "-probesize",
    "20M",
    "-analyzeduration",
    "20M",
    // keep going if the download drops for a moment (web addresses only)
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
    "-fflags",
    "+genpts+discardcorrupt",
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
  return new Promise((resolve, reject) => {
    let total = 0;
    let tail = "";
    const p = spawn(ffmpegPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr.on("data", (buf) => {
      const t = buf.toString();
      tail = (tail + t).slice(-4000);
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
        new Error(`The repair tool could not start (${e.code || e.message}).`),
      ),
    );
    p.on("close", (code, signal) => {
      if (signal || code === null) {
        reject(
          new Error(
            `The repair was stopped by the server (${signal || "killed"}) — usually because the server ran out of memory. ` +
              "Try again when the site is quiet, or convert the file on a computer (HandBrake, “Fast 1080p30”, MP4) and use “Choose new file”.",
          ),
        );
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve({ duration: total });
      } else {
        const last = tail
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-2)
          .join(" ")
          .slice(0, 300);
        reject(
          new Error(
            `The file could not be repaired (${last || `ffmpeg exit ${code}`}).`,
          ),
        );
      }
    });
  });
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

// shared runner: progress from "time=", clear messages when stopped
function runFfmpeg(args, totalSeconds, onProgress, verb) {
  return new Promise((resolve, reject) => {
    let tail = "";
    const p = spawn(ffmpegPath(), args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    p.stderr.on("data", (buf) => {
      const t = buf.toString();
      tail = (tail + t).slice(-4000);
      const times = [...t.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
      if (totalSeconds && times.length)
        onProgress(
          Math.min(
            99,
            Math.round(
              (toSeconds(times[times.length - 1][1]) / totalSeconds) * 100,
            ),
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
        reject(
          new Error(
            `The server stopped the video tool (${signal || "killed"}) — usually because it ran out of memory. Try again when the site is quiet.`,
          ),
        );
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve({ duration: totalSeconds });
      } else {
        const last = tail
          .trim()
          .split("\n")
          .filter(Boolean)
          .slice(-2)
          .join(" ")
          .slice(0, 300);
        reject(
          new Error(
            `The file could not be ${verb} (${last || `ffmpeg exit ${code}`}).`,
          ),
        );
      }
    });
  });
}

module.exports = { quickRepair, trimFile, ffmpegPath };
