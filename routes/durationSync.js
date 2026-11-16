// server-api/routes/durationSync.js
//   GET  /api/admin/videos/durations        status of the last / current sync
//   POST /api/admin/videos/durations/sync   { all?: boolean } start a sync (runs in the background)
const express = require("express");
const { requireArea } = require("../lib/teamAccess");
const sync = require("../services/durationSync");

const router = express.Router();
const access = requireArea("website", "content", "video_upload");

router.get("/", access, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...sync.status() });
});

router.post("/sync", access, express.json(), (req, res) => {
  const st = sync.status();
  if (st.running) return res.json({ ok: true, started: false, ...st });
  sync
    .run({ all: !!req.body?.all })
    .catch((e) => console.error("[durations] sync failed:", e.message));
  res.json({ ok: true, started: true, running: true });
});

module.exports = router;
