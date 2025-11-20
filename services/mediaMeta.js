// server-api/services/mediaMeta.js
const { execFile } = require("node:child_process");

/**
 * Returns duration in seconds (float) using ffprobe.
 * If ffprobe is missing or the file isn't media, returns null.
 */
async function getDurationSeconds(filePath) {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        filePath,
      ],
      (err, stdout) => {
        if (err) return resolve(null);
        const n = Number((stdout || "").trim());
        resolve(Number.isFinite(n) ? n : null);
      }
    );
  });
}

module.exports = { getDurationSeconds };
