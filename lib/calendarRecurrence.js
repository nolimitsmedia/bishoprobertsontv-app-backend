// server-api/lib/calendarRecurrence.js
//
// Repeating Calendar events, worked out in the church's time zone
// (CALENDAR_TIMEZONE, default America/New_York).
//
// Before: repeats used the first event's UTC time of day, so a "Sunday 10 AM"
// service moved to 11 AM for half the year (daylight saving), and evening
// services (e.g. Wednesday 7 PM = Thursday 00:00 UTC) landed on the wrong day.
// Now: dates follow the local calendar and the local time stays fixed.
//
// Same inputs/outputs as the functions it replaces in routes/adminCalendar.js:
//   generateOccurrences(seriesRow, fromISO, toISO) -> ["YYYY-MM-DD", …] (local dates)
//   buildOccurrenceTimestamps(baseStartISO, baseEndISO, "YYYY-MM-DD") -> { start_at, end_at }

const TZ = () => process.env.CALENDAR_TIMEZONE || "America/New_York";
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(
      tz,
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short",
      }),
    );
  }
  return fmtCache.get(tz);
}

// Local wall-clock parts of an instant in the time zone.
function localParts(date, tz = TZ()) {
  const p = {};
  for (const x of fmt(tz).formatToParts(date)) p[x.type] = x.value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour) % 24,
    mi: Number(p.minute),
    ss: Number(p.second),
    dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday),
  };
}

// The instant for a local wall-clock time in the time zone (handles DST).
function zonedToUtc(y, m, d, hh = 0, mi = 0, ss = 0, tz = TZ()) {
  const want = Date.UTC(y, m - 1, d, hh, mi, ss);
  let t = want;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(new Date(t), tz);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mi, p.ss);
    const diff = want - seen;
    if (!diff) break;
    t += diff;
  }
  return new Date(t);
}

const pad = (n) => String(n).padStart(2, "0");
const dateKey = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
function localDateOnly(date, tz = TZ()) {
  const p = localParts(date, tz);
  return dateKey(p.y, p.m, p.d);
}
// Calendar-day arithmetic on "YYYY-MM-DD" (no time zone involved).
const dayNum = (key) => {
  const [y, m, d] = key.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
};
const keyOfDayNum = (n) => {
  const dt = new Date(n * 86400000);
  return dateKey(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
};
const dowOfKey = (key) => new Date(dayNum(key) * 86400000).getUTCDay();

function defaultWeekday(baseStartISO) {
  return DOW[localParts(new Date(baseStartISO)).dow] || "SU";
}

function parseRec(seriesRow) {
  const raw =
    seriesRow.recurrence ||
    seriesRow.recurrence_json ||
    seriesRow.recurrence_rule ||
    null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function generateOccurrences(seriesRow, fromISO, toISO) {
  const rec = parseRec(seriesRow) || {};
  const freq = String(rec.freq || "weekly").toLowerCase();
  const interval = Math.max(1, Number(rec.interval) || 1);
  const startKey = localDateOnly(new Date(seriesRow.start_at));
  let toDate = new Date(toISO);
  if (rec.until) {
    const until = new Date(rec.until);
    if (!Number.isNaN(until.getTime()) && until < toDate) toDate = until;
  }
  const from = Math.max(
    dayNum(localDateOnly(new Date(fromISO))),
    dayNum(startKey),
  );
  const to = dayNum(localDateOnly(toDate));
  if (to < from) return [];
  const out = [];
  if (freq === "weekly") {
    let days = (Array.isArray(rec.byweekday) ? rec.byweekday : [])
      .map((x) =>
        DOW.indexOf(
          String(x || "")
            .trim()
            .toUpperCase(),
        ),
      )
      .filter((n) => n >= 0);
    if (!days.length) days = [DOW.indexOf(defaultWeekday(seriesRow.start_at))];
    const startWeek = Math.floor((dayNum(startKey) - dowOfKey(startKey)) / 7); // week of the start (Sun-based)
    for (let n = from; n <= to; n += 1) {
      const key = keyOfDayNum(n);
      const dow = dowOfKey(key);
      if (!days.includes(dow)) continue;
      const week = Math.floor((n - dow) / 7);
      if ((week - startWeek) % interval === 0) out.push(key);
    }
    return out;
  }
  // monthly: the start's local day of month (shortened in shorter months)
  const [sy, sm, sd] = startKey.split("-").map(Number);
  for (let i = 0; i < 1200; i += interval) {
    const y = sy + Math.floor((sm - 1 + i) / 12);
    const m = ((sm - 1 + i) % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const key = dateKey(y, m, Math.min(sd, last));
    const n = dayNum(key);
    if (n > to) break;
    if (n >= from) out.push(key);
  }
  return out;
}

function buildOccurrenceTimestamps(
  baseStartISO,
  baseEndISO,
  occurrenceDateOnly,
) {
  const base = localParts(new Date(baseStartISO));
  const [y, m, d] = String(occurrenceDateOnly).split("-").map(Number);
  const start = zonedToUtc(y, m, d, base.hh, base.mi, base.ss);
  let end = null;
  if (baseEndISO) {
    const dur =
      new Date(baseEndISO).getTime() - new Date(baseStartISO).getTime();
    if (Number.isFinite(dur) && dur >= 0) end = new Date(start.getTime() + dur);
  }
  return {
    start_at: start.toISOString(),
    end_at: end ? end.toISOString() : null,
  };
}

module.exports = {
  generateOccurrences,
  buildOccurrenceTimestamps,
  defaultWeekday,
  localParts,
  zonedToUtc,
  localDateOnly,
  TZ,
};
