// server-api/routes/adminCalendar.js
const express = require("express");
const router = express.Router();

/**
 * Single events table:
 *   calendar_events
 *
 * Recurring series tables:
 *   calendar_series
 *   calendar_series_exceptions
 *
 * API:
 *   GET    /api/admin/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   POST   /api/admin/calendar/events
 *   PUT    /api/admin/calendar/events/:id
 *   DELETE /api/admin/calendar/events/:id
 *
 *   POST   /api/admin/calendar/series
 *   PUT    /api/admin/calendar/series/:id
 *   DELETE /api/admin/calendar/series/:id
 *   POST   /api/admin/calendar/series/:id/exceptions
 */

const ALLOWED_TYPES = new Set(["live", "premiere", "upload", "meeting"]);
const ALLOWED_FREQ = new Set(["weekly", "monthly"]);
const ALLOWED_ACTION = new Set(["skip", "override"]);

function isValidISODate(v) {
  if (!v) return false;
  const d = new Date(v);
  return !Number.isNaN(d.getTime());
}

function isValidYYYYMMDD(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || "").trim());
}

function toStartOfDayISO(dateStr) {
  // dateStr: YYYY-MM-DD (UTC day boundary)
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  return d.toISOString();
}

function toEndOfDayISO(dateStr) {
  const d = new Date(`${dateStr}T23:59:59.999Z`);
  return d.toISOString();
}

function cleanText(v, max = 2000) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max) : s;
}

function cleanType(v) {
  const t = String(v || "live")
    .trim()
    .toLowerCase();
  return ALLOWED_TYPES.has(t) ? t : "live";
}

function toIntOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toISODateOnly(d) {
  // d: Date
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseDateOnlyUTC(dateStr) {
  // YYYY-MM-DD -> Date at 00:00:00Z
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function addDaysUTC(dateObj, days) {
  const d = new Date(dateObj);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function addMonthsUTC(dateObj, months) {
  const d = new Date(dateObj);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // clamp day to month length
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function weeksBetweenUTC(a, b) {
  // a, b are Date at 00:00Z; returns integer difference in weeks (floor)
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000));
}

/** Build occurrence start/end for a given date using base series times */
function buildOccurrenceTimestamps(
  baseStartISO,
  baseEndISO,
  occurrenceDateOnly,
) {
  const baseStart = new Date(baseStartISO);
  const occDay = parseDateOnlyUTC(occurrenceDateOnly);

  // Use baseStart time-of-day (UTC) on the occurrence day
  const occStart = new Date(
    Date.UTC(
      occDay.getUTCFullYear(),
      occDay.getUTCMonth(),
      occDay.getUTCDate(),
      baseStart.getUTCHours(),
      baseStart.getUTCMinutes(),
      baseStart.getUTCSeconds(),
      baseStart.getUTCMilliseconds(),
    ),
  );

  let occEnd = null;
  if (baseEndISO) {
    const baseEnd = new Date(baseEndISO);
    const durationMs = baseEnd.getTime() - baseStart.getTime();
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      occEnd = new Date(occStart.getTime() + durationMs);
    }
  }

  return {
    start_at: occStart.toISOString(),
    end_at: occEnd ? occEnd.toISOString() : null,
  };
}

/** Validate single event payload */
function validateEventBody(body) {
  const title = cleanText(body?.title, 160);
  const type = cleanType(body?.type);
  const start_at = body?.start_at;
  const end_at = body?.end_at ?? null;

  const video_id = toIntOrNull(body?.video_id);
  const category_id = toIntOrNull(body?.category_id);
  const notes = cleanText(body?.notes, 4000);

  if (!title) return { ok: false, status: 400, message: "Title is required." };
  if (!isValidISODate(start_at)) {
    return {
      ok: false,
      status: 400,
      message: "start_at must be a valid ISO date.",
    };
  }
  if (end_at && !isValidISODate(end_at)) {
    return {
      ok: false,
      status: 400,
      message: "end_at must be a valid ISO date.",
    };
  }
  if (end_at && new Date(end_at) < new Date(start_at)) {
    return {
      ok: false,
      status: 400,
      message: "end_at must be after start_at.",
    };
  }

  return {
    ok: true,
    value: { title, type, start_at, end_at, video_id, category_id, notes },
  };
}

/** Validate recurrence payload */
function validateRecurrence(rec) {
  const freq = String(rec?.freq || "weekly")
    .trim()
    .toLowerCase();
  if (!ALLOWED_FREQ.has(freq)) {
    return {
      ok: false,
      status: 400,
      message: "recurrence.freq must be weekly or monthly.",
    };
  }

  const interval = Math.max(1, Number(rec?.interval) || 1);

  let byweekday = [];
  if (freq === "weekly") {
    byweekday = Array.isArray(rec?.byweekday) ? rec.byweekday : [];
    byweekday = byweekday
      .map((x) =>
        String(x || "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean);

    const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
    byweekday = byweekday.filter((k) => allowed.has(k));

    // allow empty -> will be filled from start weekday later
  }

  let until = rec?.until ?? null;
  if (until) {
    // accept ISO or date-only; normalize to ISO
    if (isValidYYYYMMDD(until)) {
      until = `${until}T23:59:59.999Z`;
    } else if (!isValidISODate(until)) {
      return {
        ok: false,
        status: 400,
        message: "recurrence.until must be YYYY-MM-DD or ISO date.",
      };
    }
  } else {
    until = null;
  }

  return {
    ok: true,
    value: { freq, interval, byweekday, until },
  };
}

/** Generate occurrence date-only strings within [from..to] inclusive */
function generateOccurrences(seriesRow, fromISO, toISO) {
  const baseStartISO = seriesRow.start_at;
  const baseEndISO = seriesRow.end_at || null;

  const recurrence =
    seriesRow.recurrence ||
    seriesRow.recurrence_json ||
    seriesRow.recurrence_rule ||
    null;
  const rec =
    typeof recurrence === "string" ? safeJsonParse(recurrence) : recurrence;

  const freq = String(rec?.freq || "weekly").toLowerCase();
  const interval = Math.max(1, Number(rec?.interval) || 1);

  const rangeFrom = new Date(fromISO);
  const rangeTo = new Date(toISO);

  // series can’t occur before base start day
  const seriesStartDay = parseDateOnlyUTC(
    toISODateOnly(new Date(baseStartISO)),
  );

  // cap by until if present
  const untilISO = rec?.until ? new Date(rec.until).toISOString() : null;
  const capTo = untilISO
    ? new Date(Math.min(rangeTo.getTime(), new Date(untilISO).getTime()))
    : rangeTo;

  const fromDay = parseDateOnlyUTC(toISODateOnly(rangeFrom));
  const toDay = parseDateOnlyUTC(toISODateOnly(capTo));

  if (toDay.getTime() < fromDay.getTime()) return [];

  // helper: map weekday to JS getUTCDay()
  const mapDow = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  const occurrences = [];

  if (freq === "weekly") {
    let byweekday = Array.isArray(rec?.byweekday) ? rec.byweekday : [];
    byweekday = byweekday
      .map((x) =>
        String(x || "")
          .trim()
          .toUpperCase(),
      )
      .filter(Boolean);

    // if empty, default to base start weekday
    if (!byweekday.length) {
      const baseStart = new Date(baseStartISO);
      const inv = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      byweekday = [inv[baseStart.getUTCDay()] || "SU"];
    }

    const allowedDowNums = new Set(
      byweekday.map((k) => mapDow[k]).filter((n) => n !== undefined),
    );

    // Iterate day-by-day; include if weekday matches AND week offset matches interval
    let d = new Date(fromDay);
    while (d.getTime() <= toDay.getTime()) {
      // must not occur before series start
      if (d.getTime() >= seriesStartDay.getTime()) {
        const dow = d.getUTCDay();
        if (allowedDowNums.has(dow)) {
          const w = weeksBetweenUTC(seriesStartDay, d);
          if (w % interval === 0) {
            occurrences.push(toISODateOnly(d));
          }
        }
      }
      d = addDaysUTC(d, 1);
    }
    return occurrences;
  }

  // monthly
  // rule: repeat on the day-of-month of baseStart, every N months
  const baseStart = new Date(baseStartISO);
  const dom = baseStart.getUTCDate();

  // find the first month occurrence >= fromDay
  // start from series start month and step interval months until >= from
  let cur = new Date(
    Date.UTC(seriesStartDay.getUTCFullYear(), seriesStartDay.getUTCMonth(), 1),
  );
  // build occurrence in that month
  function occInMonth(monthFirst) {
    const lastDay = new Date(
      Date.UTC(monthFirst.getUTCFullYear(), monthFirst.getUTCMonth() + 1, 0),
    ).getUTCDate();
    const day = Math.min(dom, lastDay);
    return new Date(
      Date.UTC(monthFirst.getUTCFullYear(), monthFirst.getUTCMonth(), day),
    );
  }

  // Align months to interval based on series start month
  const seriesMonth0 = new Date(
    Date.UTC(seriesStartDay.getUTCFullYear(), seriesStartDay.getUTCMonth(), 1),
  );

  // move cur forward to at least fromDay
  while (occInMonth(cur).getTime() < fromDay.getTime()) {
    cur = addMonthsUTC(cur, 1);
  }

  // now iterate month-by-month and include only those matching interval
  let monthIter = new Date(cur);
  while (true) {
    const occDay = occInMonth(monthIter);
    if (occDay.getTime() > toDay.getTime()) break;

    // interval check: months between seriesMonth0 and this monthIter
    const monthsBetween =
      (monthIter.getUTCFullYear() - seriesMonth0.getUTCFullYear()) * 12 +
      (monthIter.getUTCMonth() - seriesMonth0.getUTCMonth());

    if (monthsBetween >= 0 && monthsBetween % interval === 0) {
      // must not occur before series start day
      if (occDay.getTime() >= seriesStartDay.getTime()) {
        occurrences.push(toISODateOnly(occDay));
      }
    }

    monthIter = addMonthsUTC(monthIter, 1);
  }

  return occurrences;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/* =======================================================
   GET /api/admin/calendar/events?from=YYYY-MM-DD&to=YYYY-MM-DD
   Returns single events + expanded recurring occurrences in range.
========================================================== */
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

    const fromStr = String(from).trim();
    const toStr = String(to).trim();

    if (!isValidYYYYMMDD(fromStr) || !isValidYYYYMMDD(toStr)) {
      return res.status(400).json({
        ok: false,
        message: "Invalid date format. Use from/to as YYYY-MM-DD.",
      });
    }

    const fromISO = toStartOfDayISO(fromStr);
    const toISO = toEndOfDayISO(toStr);

    // 1) Single events
    const singleQ = `
      SELECT
        id, title, type, start_at, end_at, video_id, category_id, notes,
        created_at, updated_at
      FROM calendar_events
      WHERE start_at >= $1::timestamptz
        AND start_at <= $2::timestamptz
      ORDER BY start_at ASC
    `;
    const singleR = await db.query(singleQ, [fromISO, toISO]);
    const singles = singleR.rows || [];

    // 2) Recurring series that could overlap this range
    // recurrence stored in recurrence_json (jsonb)
    const seriesQ = `
      SELECT
        id, title, type, start_at, end_at, video_id, category_id, notes,
        recurrence_json,
        created_at, updated_at
      FROM calendar_series
      WHERE start_at <= $2::timestamptz
        AND (
          (recurrence_json->>'until') IS NULL
          OR (recurrence_json->>'until')::timestamptz >= $1::timestamptz
        )
      ORDER BY start_at ASC
    `;
    const seriesR = await db.query(seriesQ, [fromISO, toISO]);
    const seriesRows = seriesR.rows || [];

    // 3) Exceptions in range (skip/override)
    const excQ = `
      SELECT id, series_id, date, action, override_json, created_at
      FROM calendar_series_exceptions
      WHERE date >= $1::date AND date <= $2::date
    `;
    const excR = await db.query(excQ, [fromStr, toStr]);
    const excRows = excR.rows || [];

    const excBySeriesDate = new Map();
    for (const ex of excRows) {
      const key = `${ex.series_id}::${ex.date}`;
      excBySeriesDate.set(key, ex);
    }

    const expanded = [];

    for (const s of seriesRows) {
      const recurrence = s.recurrence_json || {};
      const rec =
        typeof recurrence === "string" ? safeJsonParse(recurrence) : recurrence;

      const occurrences = generateOccurrences(
        {
          ...s,
          recurrence: rec,
          recurrence_json: rec,
        },
        fromISO,
        toISO,
      );

      for (const dateOnly of occurrences) {
        const exKey = `${s.id}::${dateOnly}`;
        const ex = excBySeriesDate.get(exKey);

        if (ex && String(ex.action).toLowerCase() === "skip") {
          continue; // skipped occurrence
        }

        let override = null;
        if (ex && String(ex.action).toLowerCase() === "override") {
          override =
            typeof ex.override_json === "string"
              ? safeJsonParse(ex.override_json)
              : ex.override_json;
        }

        const base = {
          title: s.title,
          type: s.type,
          start_at: s.start_at,
          end_at: s.end_at || null,
          video_id: s.video_id ?? null,
          category_id: s.category_id ?? null,
          notes: s.notes || "",
        };

        const merged = override ? { ...base, ...override } : base;

        const ts = buildOccurrenceTimestamps(
          merged.start_at,
          merged.end_at,
          dateOnly,
        );

        expanded.push({
          // string id is fine for the frontend (it only uses it as key/display)
          id: `s${s.id}-${dateOnly}`,
          series_id: s.id,
          occurrence_date: dateOnly,

          title: merged.title,
          type: cleanType(merged.type),

          start_at: ts.start_at,
          end_at: ts.end_at,

          video_id: toIntOrNull(merged.video_id),
          category_id: toIntOrNull(merged.category_id),
          notes: cleanText(merged.notes, 4000),

          created_at: s.created_at,
          updated_at: s.updated_at,
        });
      }
    }

    const all = [...singles, ...expanded].sort(
      (a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime(),
    );

    return res.json({ ok: true, events: all });
  } catch (e) {
    console.error("[adminCalendar] GET /events error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   POST /api/admin/calendar/events (single)
========================================================== */
router.post("/events", async (req, res) => {
  try {
    const db = req.db;

    const v = validateEventBody(req.body);
    if (!v.ok)
      return res.status(v.status).json({ ok: false, message: v.message });

    const { title, type, start_at, end_at, video_id, category_id, notes } =
      v.value;

    const q = `
      INSERT INTO calendar_events
        (title, type, start_at, end_at, video_id, category_id, notes, updated_at)
      VALUES
        ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, now())
      RETURNING
        id, title, type, start_at, end_at, video_id, category_id, notes, created_at, updated_at
    `;
    const r = await db.query(q, [
      title,
      type,
      start_at,
      end_at,
      video_id,
      category_id,
      notes,
    ]);

    return res.json({ ok: true, event: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] POST /events error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   PUT /api/admin/calendar/events/:id (single)
========================================================== */
router.put("/events/:id", async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid event id." });
    }

    const v = validateEventBody(req.body);
    if (!v.ok)
      return res.status(v.status).json({ ok: false, message: v.message });

    const { title, type, start_at, end_at, video_id, category_id, notes } =
      v.value;

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
      title,
      type,
      start_at,
      end_at,
      video_id,
      category_id,
      notes,
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

/* =======================================================
   DELETE /api/admin/calendar/events/:id (single)
========================================================== */
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

/* =======================================================
   POST /api/admin/calendar/series
   body: { title, type, start_at, end_at?, video_id?, category_id?, notes?, recurrence: { freq, interval, byweekday?, until? } }
========================================================== */
router.post("/series", async (req, res) => {
  try {
    const db = req.db;

    const ev = validateEventBody(req.body);
    if (!ev.ok)
      return res.status(ev.status).json({ ok: false, message: ev.message });

    const recV = validateRecurrence(req.body?.recurrence);
    if (!recV.ok)
      return res.status(recV.status).json({ ok: false, message: recV.message });

    const { title, type, start_at, end_at, video_id, category_id, notes } =
      ev.value;

    // If weekly and byweekday empty, default to start_at weekday
    const rec = { ...recV.value };
    if (
      rec.freq === "weekly" &&
      (!rec.byweekday || rec.byweekday.length === 0)
    ) {
      const baseStart = new Date(start_at);
      const inv = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      rec.byweekday = [inv[baseStart.getUTCDay()] || "SU"];
    }

    const q = `
      INSERT INTO calendar_series
        (title, type, start_at, end_at, video_id, category_id, notes, recurrence_json, updated_at)
      VALUES
        ($1, $2, $3::timestamptz, $4::timestamptz, $5, $6, $7, $8::jsonb, now())
      RETURNING
        id, title, type, start_at, end_at, video_id, category_id, notes, recurrence_json, created_at, updated_at
    `;

    const r = await db.query(q, [
      title,
      type,
      start_at,
      end_at,
      video_id,
      category_id,
      notes,
      JSON.stringify(rec),
    ]);

    return res.json({ ok: true, series: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] POST /series error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   PUT /api/admin/calendar/series/:id
========================================================== */
router.put("/series/:id", async (req, res) => {
  try {
    const db = req.db;
    const id = Number(req.params.id);

    if (!Number.isFinite(id)) {
      return res.status(400).json({ ok: false, message: "Invalid series id." });
    }

    const ev = validateEventBody(req.body);
    if (!ev.ok)
      return res.status(ev.status).json({ ok: false, message: ev.message });

    const recV = validateRecurrence(req.body?.recurrence);
    if (!recV.ok)
      return res.status(recV.status).json({ ok: false, message: recV.message });

    const { title, type, start_at, end_at, video_id, category_id, notes } =
      ev.value;

    const rec = { ...recV.value };
    if (
      rec.freq === "weekly" &&
      (!rec.byweekday || rec.byweekday.length === 0)
    ) {
      const baseStart = new Date(start_at);
      const inv = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
      rec.byweekday = [inv[baseStart.getUTCDay()] || "SU"];
    }

    const q = `
      UPDATE calendar_series
      SET
        title = $1,
        type = $2,
        start_at = $3::timestamptz,
        end_at = $4::timestamptz,
        video_id = $5,
        category_id = $6,
        notes = $7,
        recurrence_json = $8::jsonb,
        updated_at = now()
      WHERE id = $9
      RETURNING
        id, title, type, start_at, end_at, video_id, category_id, notes, recurrence_json, created_at, updated_at
    `;

    const r = await db.query(q, [
      title,
      type,
      start_at,
      end_at,
      video_id,
      category_id,
      notes,
      JSON.stringify(rec),
      id,
    ]);

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, message: "Series not found." });
    }

    return res.json({ ok: true, series: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] PUT /series/:id error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   DELETE /api/admin/calendar/series/:id
========================================================== */
router.delete("/series/:id", async (req, res) => {
  const db = req.db;
  const id = Number(req.params.id);

  if (!Number.isFinite(id)) {
    return res.status(400).json({ ok: false, message: "Invalid series id." });
  }

  try {
    await db.query("BEGIN");

    // delete exceptions first (unless you have ON DELETE CASCADE)
    await db.query(
      `DELETE FROM calendar_series_exceptions WHERE series_id = $1`,
      [id],
    );

    const r = await db.query(
      `DELETE FROM calendar_series WHERE id = $1 RETURNING id`,
      [id],
    );
    if (r.rowCount === 0) {
      await db.query("ROLLBACK");
      return res.status(404).json({ ok: false, message: "Series not found." });
    }

    await db.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    try {
      await db.query("ROLLBACK");
    } catch {}
    console.error("[adminCalendar] DELETE /series/:id error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

/* =======================================================
   POST /api/admin/calendar/series/:id/exceptions
   body:
     { date: 'YYYY-MM-DD', action: 'skip' }
   or
     { date: 'YYYY-MM-DD', action: 'override', override: { title?, type?, start_at?, end_at?, video_id?, category_id?, notes? } }
========================================================== */
router.post("/series/:id/exceptions", async (req, res) => {
  try {
    const db = req.db;
    const seriesId = Number(req.params.id);

    if (!Number.isFinite(seriesId)) {
      return res.status(400).json({ ok: false, message: "Invalid series id." });
    }

    const date = String(req.body?.date || "").trim();
    const action = String(req.body?.action || "")
      .trim()
      .toLowerCase();

    if (!isValidYYYYMMDD(date)) {
      return res
        .status(400)
        .json({ ok: false, message: "date must be YYYY-MM-DD." });
    }
    if (!ALLOWED_ACTION.has(action)) {
      return res
        .status(400)
        .json({ ok: false, message: "action must be skip or override." });
    }

    let overrideJson = null;

    if (action === "override") {
      const o = req.body?.override || {};
      // allow partial override; validate dates if provided
      if (o.start_at && !isValidISODate(o.start_at)) {
        return res.status(400).json({
          ok: false,
          message: "override.start_at must be ISO date if provided.",
        });
      }
      if (o.end_at && !isValidISODate(o.end_at)) {
        return res.status(400).json({
          ok: false,
          message: "override.end_at must be ISO date if provided.",
        });
      }
      if (o.start_at && o.end_at && new Date(o.end_at) < new Date(o.start_at)) {
        return res.status(400).json({
          ok: false,
          message: "override.end_at must be after override.start_at.",
        });
      }

      overrideJson = {
        ...(o.title !== undefined ? { title: cleanText(o.title, 160) } : {}),
        ...(o.type !== undefined ? { type: cleanType(o.type) } : {}),
        ...(o.start_at !== undefined ? { start_at: o.start_at } : {}),
        ...(o.end_at !== undefined ? { end_at: o.end_at } : {}),
        ...(o.video_id !== undefined
          ? { video_id: toIntOrNull(o.video_id) }
          : {}),
        ...(o.category_id !== undefined
          ? { category_id: toIntOrNull(o.category_id) }
          : {}),
        ...(o.notes !== undefined ? { notes: cleanText(o.notes, 4000) } : {}),
      };
    }

    // Upsert exception per (series_id, date)
    const q = `
      INSERT INTO calendar_series_exceptions
        (series_id, date, action, override_json, created_at)
      VALUES
        ($1, $2::date, $3, $4::jsonb, now())
      ON CONFLICT (series_id, date)
      DO UPDATE SET
        action = EXCLUDED.action,
        override_json = EXCLUDED.override_json
      RETURNING id, series_id, date, action, override_json, created_at
    `;

    const r = await db.query(q, [
      seriesId,
      date,
      action,
      overrideJson ? JSON.stringify(overrideJson) : null,
    ]);

    return res.json({ ok: true, exception: r.rows[0] });
  } catch (e) {
    console.error("[adminCalendar] POST /series/:id/exceptions error:", e);
    return res.status(500).json({ ok: false, message: "Server error" });
  }
});

module.exports = router;
