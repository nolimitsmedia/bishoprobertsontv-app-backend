// server-api/routes/adminCalendar.js
const express = require("express");
const router = express.Router();

function isValidISODate(v) {
  if (!v) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function toStartOfDayISO(dateStr) {
  // dateStr: YYYY-MM-DD
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return d.toISOString();
}

function toEndOfDayISO(dateStr) {
  const d = new Date(`${dateStr}T23:59:59.999Z`);
  return d.toISOString();
}

// GET /api/admin/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get("/events", async (req, res) => {
  try {
    const db = req.db;
    const { from, to } = req.query;

    if (!from || !to) {
      return res.status(400).json({
        ok: false,
        message: "Missing query params: from=YYYY-MM-DD&to=YYYY-MM-DD",
      });
    }

    // Convert date range to inclusive timestamps
    const fromISO = toStartOfDayISO(from);
    const toISO = toEndOfDayISO(to);

    const q = `
      SELECT
        id, title, type, start_at, end_at, video_id, category_id, notes,
        created_at, updated_at
      FROM calendar_events
      WHERE start_at >= $1::timestamptz
        AND start_at <= $2::timestamptz
      ORDER BY start_at ASC
    `;
    const r = await db.query(q, [fromISO, toISO]);

    return res.json({ ok: true, events: r.rows || [] });
  } catch (e) {
    console.error("[adminCalendar] GET /events error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// POST /api/admin/calendar/events
router.post("/events", async (req, res) => {
  try {
    const db = req.db;
    const {
      title,
      type = "live",
      start_at,
      end_at = null,
      video_id = null,
      category_id = null,
      notes = "",
    } = req.body || {};

    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) {
      return res.status(400).json({ ok: false, message: "Title is required." });
    }
    if (!isValidISODate(start_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "start_at must be a valid ISO date." });
    }
    if (end_at && !isValidISODate(end_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "end_at must be a valid ISO date." });
    }
    if (end_at && new Date(end_at) < new Date(start_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "end_at must be after start_at." });
    }

    const q = `
      INSERT INTO calendar_events
        (title, type, start_at, end_at, video_id, category_id, notes, updated_at)
      VALUES
        ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, now())
      RETURNING
        id, title, type, start_at, end_at, video_id, category_id, notes, created_at, updated_at
    `;
    const params = [
      cleanTitle,
      String(type || "live"),
      start_at,
      end_at,
      video_id ? Number(video_id) : null,
      category_id ? Number(category_id) : null,
      String(notes || "").trim(),
    ];

    const r = await db.query(q, params);
    return res.json({ ok: true, event: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] POST /events error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// PUT /api/admin/calendar/events/:id
router.put("/events/:id", async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid event id." });
    }

    const {
      title,
      type = "live",
      start_at,
      end_at = null,
      video_id = null,
      category_id = null,
      notes = "",
    } = req.body || {};

    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) {
      return res.status(400).json({ ok: false, message: "Title is required." });
    }
    if (!isValidISODate(start_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "start_at must be a valid ISO date." });
    }
    if (end_at && !isValidISODate(end_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "end_at must be a valid ISO date." });
    }
    if (end_at && new Date(end_at) < new Date(start_at)) {
      return res
        .status(400)
        .json({ ok: false, message: "end_at must be after start_at." });
    }

    const q = `
      UPDATE calendar_events
      SET
        title = $1,
        type = $2,
        start_at = $3::timestamptz,
        end_at = $4::timestamptz,
        video_id = $5,
        category_id = $6,
        notes = $7,
        updated_at = now()
      WHERE id = $8
      RETURNING
        id, title, type, start_at, end_at, video_id, category_id, notes, created_at, updated_at
    `;

    const r = await db.query(q, [
      cleanTitle,
      String(type || "live"),
      start_at,
      end_at,
      video_id ? Number(video_id) : null,
      category_id ? Number(category_id) : null,
      String(notes || "").trim(),
      id,
    ]);

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Event not found." });
    }

    return res.json({ ok: true, event: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] PUT /events/:id error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

// DELETE /api/admin/calendar/events/:id
router.delete("/events/:id", async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid event id." });
    }

    const q = `DELETE FROM calendar_events WHERE id = $1 RETURNING id`;
    const r = await db.query(q, [id]);

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Event not found." });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[adminCalendar] DELETE /events/:id error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
