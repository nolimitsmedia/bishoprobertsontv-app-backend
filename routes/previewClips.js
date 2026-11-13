// server-api/routes/previewClips.js
//
// Release 2.3 Part B — admin: Content › Preview Clips.
//   GET  /api/admin/preview-clips        eligible videos, clip status, totals
//   POST /api/admin/preview-clips/run    { scope: "missing"|"outdated"|"failed" } or { ids: [...] }

const express = require("express");
const { requireArea } = require("../lib/teamAccess");
const clips = require("../services/previewClips");

const router = express.Router();
const access = requireArea("website", "content", "video_upload");

router.get("/", access, async (_req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const items = await clips.list();
    const summary = { total: items.length };
    for (const s of [
      "ready",
      "missing",
      "outdated",
      "failed",
      "queued",
      "processing",
    ])
      summary[s] = items.filter((v) => v.status === s).length;
    res.json({
      ok: true,
      summary,
      items,
      queue: clips.queueState(),
      auto:
        String(process.env.PREVIEW_CLIPS_AUTO || "").toLowerCase() === "true",
    });
  } catch (e) {
    console.error("[preview clips] list failed:", e);
    res.status(500).json({ ok: false, error: "Unable to load preview clips" });
  }
});

router.post("/run", access, express.json(), async (req, res) => {
  try {
    let ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map(Number).filter(Number.isSafeInteger).slice(0, 500)
      : [];
    const scope = String(req.body?.scope || "");
    if (!ids.length && ["missing", "outdated", "failed"].includes(scope)) {
      ids = (await clips.list())
        .filter((v) => v.status === scope)
        .map((v) => v.id);
    }
    if (!ids.length) return res.json({ ok: true, queued: 0 });
    const queued = await clips.enqueue(ids);
    res.json({ ok: true, queued });
  } catch (e) {
    console.error("[preview clips] run failed:", e);
    res.status(500).json({ ok: false, error: "Could not start" });
  }
});

module.exports = router;
