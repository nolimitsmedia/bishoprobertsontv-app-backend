// server-api/routes/analytics.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ---------------------------
   Optional auth middleware
   - If your middleware/auth doesn't export requireAuthOptional,
     we fall back to a no-op that only *tries* to decode JWT.
---------------------------- */
let requireAuthOptional;
try {
  // Try to import from your shared auth
  ({ requireAuthOptional } = require("../middleware/auth"));
} catch (_) {
  // ignore
}
if (typeof requireAuthOptional !== "function") {
  const jwt = require("jsonwebtoken");
  requireAuthOptional = (req, _res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (token) {
      try {
        const p = jwt.verify(token, process.env.JWT_SECRET);
        req.user = { id: p.id || p.sub || p.userId, email: p.email, ...p };
      } catch {
        // ignore bad tokens for analytics
      }
    }
    next();
  };
}

/* ---------------------------
   Ensure table exists (fire & forget)
---------------------------- */
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id              SERIAL PRIMARY KEY,
        type            TEXT NOT NULL,
        video_id        INTEGER,
        user_id         INTEGER,
        anon_id         TEXT,
        page            TEXT,
        position_sec    NUMERIC,
        duration_sec    NUMERIC,
        created_at      TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS analytics_events_created_at_idx
        ON analytics_events (created_at DESC);
    `);
  } catch (e) {
    console.warn("[analytics] ensure table failed:", e.message || e);
  }
})();

/* ---------------------------
   Helpers
---------------------------- */
const ALLOWED = new Set([
  "page_view",
  "video_start",
  "video_progress",
  "video_complete",
  "video_stop",
]);
const numOrNull = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/* ---------------------------
   POST /api/analytics/track
---------------------------- */
router.post("/track", requireAuthOptional, async (req, res) => {
  try {
    const { type, video_id, page, anon_id, position_sec, duration_sec } =
      req.body || {};

    if (!ALLOWED.has(String(type || ""))) {
      return res.status(400).json({ error: "Invalid or missing type" });
    }

    await db.query(
      `INSERT INTO analytics_events
       (type, video_id, user_id, anon_id, page, position_sec, duration_sec)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        String(type),
        video_id != null ? Number(video_id) : null,
        req.user?.id || null,
        anon_id || null,
        page || null,
        numOrNull(position_sec),
        numOrNull(duration_sec),
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[analytics] track error:", e);
    res.status(500).json({ error: "Failed to record analytics event" });
  }
});

/* ---------------------------
   GET /api/analytics/recent (debug)
---------------------------- */
router.get("/recent", async (_req, res) => {
  try {
    const q = await db.query(
      "SELECT * FROM analytics_events ORDER BY created_at DESC LIMIT 50"
    );
    res.json({ items: q.rows });
  } catch (e) {
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

module.exports = router;
