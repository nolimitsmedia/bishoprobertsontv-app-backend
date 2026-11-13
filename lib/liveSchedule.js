// server-api/lib/liveSchedule.js
//
// The live service schedule, from the site's Calendar (Content › Calendar):
//  - one-off events of type "live" (calendar_events)
//  - repeating series of type "live" (calendar_series), worked out in the
//    church's time zone, with skipped / changed dates (calendar_series_exceptions)
//  - older schedule tables some installs use (admin_calendar_items, …)
// Used by: live status / LIVE badge, countdowns (Home, live page, Countdown
// element), and "Notify me" reminders.

const db = require("../db");
const {
  generateOccurrences,
  buildOccurrenceTimestamps,
} = require("./calendarRecurrence");

const isLive = (t) => /live/i.test(String(t || ""));
async function safe(sql, params) {
  try {
    return (await db.query(sql, params)).rows;
  } catch {
    return []; // table not on this install
  }
}

// Live services starting in [from, to] (plus, if `around` is set, any that
// started up to that many minutes before `from` — for "on now").
async function upcoming(from, to, { aroundMinutes = 0 } = {}) {
  const fromMs = from.getTime() - aroundMinutes * 60000;
  const lo = new Date(fromMs).toISOString();
  const hi = to.toISOString();
  const out = [];
  // one-off Calendar events
  for (const r of await safe(
    `SELECT id, title, type, start_at, end_at FROM calendar_events
      WHERE start_at >= $1 AND start_at <= $2 ORDER BY start_at`,
    [lo, hi],
  )) {
    if (isLive(r.type))
      out.push({
        key: `ev:${r.id}`,
        title: r.title,
        start_at: new Date(r.start_at),
        end_at: r.end_at ? new Date(r.end_at) : null,
      });
  }
  // repeating series
  const series = await safe(
    `SELECT id, title, type, start_at, end_at, recurrence_json FROM calendar_series`,
  );
  const exc = await safe(
    `SELECT series_id, date, action, override_json FROM calendar_series_exceptions`,
  );
  const exMap = new Map(
    exc.map((e) => [
      `${e.series_id}|${String(e.date instanceof Date ? e.date.toISOString() : e.date).slice(0, 10)}`,
      e,
    ]),
  );
  for (const s of series) {
    // an override can change the type, so check per occurrence
    const dates = generateOccurrences(
      s,
      new Date(fromMs - 2 * 86400000).toISOString(),
      new Date(to.getTime() + 2 * 86400000).toISOString(),
    );
    for (const dateOnly of dates) {
      const ex = exMap.get(`${s.id}|${dateOnly}`);
      if (ex && String(ex.action).toLowerCase() === "skip") continue;
      const ov =
        ex && String(ex.action).toLowerCase() === "override"
          ? ex.override_json || {}
          : {};
      const merged = { ...s, ...ov };
      if (!isLive(merged.type)) continue;
      const ts = buildOccurrenceTimestamps(
        merged.start_at,
        merged.end_at,
        dateOnly,
      );
      const start = new Date(ts.start_at);
      if (start.getTime() < fromMs || start > to) continue;
      out.push({
        key: `series:${s.id}:${dateOnly}`,
        title: merged.title,
        start_at: start,
        end_at: ts.end_at ? new Date(ts.end_at) : null,
      });
    }
  }
  // older tables (compatibility)
  for (const [table, startCol, endCol] of [
    ["admin_calendar_items", "start_time", "end_time"],
    ["calendar_items", "start_time", "end_time"],
  ]) {
    for (const r of await safe(
      `SELECT id, COALESCE(title, name) AS title, ${startCol} AS start_at, ${endCol} AS end_at
         FROM ${table}
        WHERE ${startCol} >= $1 AND ${startCol} <= $2 AND COALESCE(type, category, '') ILIKE '%live%'`,
      [lo, hi],
    )) {
      out.push({
        key: `${table}:${r.id}`,
        title: r.title,
        start_at: new Date(r.start_at),
        end_at: r.end_at ? new Date(r.end_at) : null,
      });
    }
  }
  return out.sort((a, b) => a.start_at - b.start_at);
}

async function nextLive(now = new Date()) {
  const list = await upcoming(
    new Date(now.getTime() + 1000),
    new Date(now.getTime() + 60 * 86400000),
  );
  return list[0] || null;
}

async function currentLive(now = new Date(), windowMinutes = 120) {
  const list = await upcoming(now, now, { aroundMinutes: 24 * 60 });
  return (
    list
      .filter(
        (e) =>
          e.start_at <= now &&
          now <
            (e.end_at ||
              new Date(e.start_at.getTime() + windowMinutes * 60000)),
      )
      .pop() || null
  );
}

module.exports = { upcoming, nextLive, currentLive };
