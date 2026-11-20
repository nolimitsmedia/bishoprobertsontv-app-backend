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
    "4096",
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
    p.on("close", (code) => {
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

module.exports = { quickRepair, ffmpegPath };
