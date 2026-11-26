// server-api/services/emailAutomationWorker.js
//
// Every 10 minutes: finds who should get each automatic email that is
// switched ON in Admin › Email Automations, and sends it.
//
//   welcome_followup   3–7 days after sign-up
//   new_video          videos published in the last 48 h (max 3 a day per person)
//   weekly_roundup     on the roundup day/hour (Settings), videos from the last 7 days
//   continue_watching  a video left 10–90% watched, no watching for N days (Settings)
//   we_miss_you        no activity for N days (Settings), once per absence
//
// Safety: each automation only looks at a short recent window (so switching
// one on never emails the whole list), new-sermon alerts never cover videos
// published before they were switched on, each email has a once-only key (email_send_log.dedupe_key), unsubscribes are
// respected, and each run sends at most EMAIL_AUTOMATION_BATCH emails (default
// 200) — the rest go on the next run.
// Turn the whole job off with EMAIL_AUTOMATIONS=off.

const db = require("../db");
const T = require("./emailTemplates");

const INTERVAL_MS = 10 * 60 * 1000;
const TZ = () => process.env.CALENDAR_TIMEZONE || "America/New_York";
const BATCH = () =>
  Math.max(
    1,
    Math.min(2000, Number(process.env.EMAIL_AUTOMATION_BATCH) || 200),
  );

// Published, publicly listed videos (same rule as the public video pages).
const PUBLIC_VIDEO =
  "v.is_published = TRUE AND COALESCE(v.visibility, 'public') <> 'unlisted'";

function thumb(url) {
  const u = String(url || "").trim();
  if (/^https:\/\//i.test(u)) return u;
  if (u.startsWith("/uploads") && T.apiUrl().startsWith("https://"))
    return `${T.apiUrl()}${u}`;
  return "";
}
function minutes(sec) {
  const n = Math.round(Number(sec || 0) / 60);
  return n > 0 ? `${n} min` : "";
}
function videoItem(v) {
  return {
    title: v.title || "Untitled",
    url: T.sitePage(`watch/${v.id}`),
    image: thumb(v.thumbnail_url),
    subtitle: minutes(v.duration_seconds),
  };
}

async function tableExists(name) {
  try {
    const { rows } = await db.query("SELECT to_regclass($1) AS t", [
      `public.${name}`,
    ]);
    return !!rows[0]?.t;
  } catch {
    return false;
  }
}
async function videoColumns() {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'videos'`,
  );
  return new Set(rows.map((r) => r.column_name));
}

// Local weekday + hour in the ministry's time zone.
function localNow(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ(),
      weekday: "short",
      hour: "numeric",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: String(parts.weekday || "")
      .slice(0, 3)
      .toLowerCase(),
    hour: Number(parts.hour),
    date: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function isoWeek(d) {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 86400000 + 1) / 7)).padStart(2, "0")}`;
}

// Recipients not yet handled for this once-only key (sent or skipped).
const NOT_DONE = (keyExpr) =>
  `NOT EXISTS (SELECT 1 FROM email_send_log l WHERE l.dedupe_key = ${keyExpr})`;

async function runOnce({ now = new Date(), budget = BATCH() } = {}) {
  const out = {};
  if (String(process.env.EMAIL_AUTOMATIONS || "").toLowerCase() === "off")
    return { off: true };
  await T.ensureSchema();
  const settings = await T.getSettings();
  const tpls = Object.fromEntries(
    (await T.listTemplates()).map((t) => [t.key, t]),
  );
  let left = budget;
  const send = async (key, user, vars, dedupe) => {
    if (left <= 0) return false;
    left -= 1;
    const r = await T.sendTemplated(key, {
      to: user.email,
      vars: { name: user.name || "", ...vars },
      dedupe,
    });
    out[key] = out[key] || { sent: 0, skipped: 0, failed: 0 };
    if (r.status === "sent") out[key].sent += 1;
    else if (r.status === "failed") out[key].failed += 1;
    else out[key].skipped += 1;
    return true;
  };
  const on = (k) => tpls[k]?.enabled;
  const since = (k) => tpls[k]?.enabled_at || now; // never reach back before switch-on
  const cols = await videoColumns().catch(() => new Set());
  const pubCol = cols.has("published_at")
    ? "COALESCE(v.published_at, v.created_at)"
    : "v.created_at";
  const durCol = cols.has("duration_seconds")
    ? "v.duration_seconds"
    : cols.has("duration")
      ? "v.duration"
      : "NULL";
  const thumbCol = cols.has("thumbnail_url") ? "v.thumbnail_url" : "NULL";
  const descCol = cols.has("description") ? "v.description" : "NULL";

  // ── 1. Welcome follow-up: signed up 3–7 days ago (and after switch-on − 7 days) ──
  if (on("welcome_followup") && left > 0) {
    const { rows } = await db.query(
      `SELECT u.id, u.name, u.email FROM users u
        WHERE u.email IS NOT NULL AND u.email <> ''
          AND u.created_at <= $1::timestamptz - INTERVAL '3 days'
          AND u.created_at >  $1::timestamptz - INTERVAL '7 days'
          AND ${NOT_DONE("'welcome2:' || lower(u.email)")}
        ORDER BY u.created_at LIMIT $2`,
      [now, left],
    );
    for (const u of rows)
      await send(
        "welcome_followup",
        u,
        {},
        `welcome2:${u.email.toLowerCase()}`,
      );
  }

  // ── 2. New sermon alert: each video published in the last 48 h ──
  if (on("new_video") && left > 0) {
    const { rows: vids } = await db.query(
      `SELECT v.id, v.title, ${descCol} AS description, ${thumbCol} AS thumbnail_url, ${pubCol} AS published
         FROM videos v
        WHERE ${PUBLIC_VIDEO}
          AND ${pubCol} > $1::timestamptz - INTERVAL '48 hours'
          AND ${pubCol} >= $2::timestamptz
          AND ${pubCol} <= $1::timestamptz
        ORDER BY published LIMIT 10`,
      [now, since("new_video")],
    );
    for (const v of vids) {
      if (left <= 0) break;
      const { rows } = await db.query(
        `SELECT u.id, u.name, u.email FROM users u
          WHERE u.email IS NOT NULL AND u.email <> ''
            AND ${NOT_DONE(`'video:${Number(v.id)}:' || lower(u.email)`)}
            AND (SELECT COUNT(*) FROM email_send_log l
                  WHERE l.template_key = 'new_video' AND l.status = 'sent'
                    AND l.email = lower(u.email) AND l.created_at > $1::timestamptz - INTERVAL '24 hours') < 3
          ORDER BY u.id LIMIT $2`,
        [now, left],
      );
      const desc = String(v.description || "")
        .replace(/\s+/g, " ")
        .trim();
      for (const u of rows)
        await send(
          "new_video",
          u,
          {
            video_title: v.title || "A new message",
            video_description:
              desc.length > 280 ? `${desc.slice(0, 277)}…` : desc,
            video_url: T.sitePage(`watch/${v.id}`),
            thumbnail_url: thumb(v.thumbnail_url),
          },
          `video:${Number(v.id)}:${u.email.toLowerCase()}`,
        );
    }
  }

  // ── 3. Weekly roundup: on the chosen day, from the chosen hour ──
  if (on("weekly_roundup") && left > 0) {
    const ln = localNow(now);
    if (
      ln.day === settings.roundup_day &&
      ln.hour >= Number(settings.roundup_hour)
    ) {
      const { rows: vids } = await db.query(
        `SELECT v.id, v.title, ${thumbCol} AS thumbnail_url, ${durCol} AS duration_seconds
           FROM videos v
          WHERE ${PUBLIC_VIDEO}
            AND ${pubCol} > $1::timestamptz - INTERVAL '7 days' AND ${pubCol} <= $1::timestamptz
          ORDER BY ${pubCol} DESC LIMIT 8`,
        [now],
      );
      if (vids.length) {
        const key = `weekly:${ln.date}:`;
        const { rows } = await db.query(
          `SELECT u.id, u.name, u.email FROM users u
            WHERE u.email IS NOT NULL AND u.email <> ''
              AND ${NOT_DONE(`'${key}' || lower(u.email)`)}
            ORDER BY u.id LIMIT $1`,
          [left],
        );
        const items = vids.map(videoItem);
        for (const u of rows)
          await send(
            "weekly_roundup",
            u,
            { _items: items, video_count: String(vids.length) },
            `${key}${u.email.toLowerCase()}`,
          );
      }
    }
  }

  // ── 4. Continue watching ──
  if (
    on("continue_watching") &&
    left > 0 &&
    (await tableExists("watch_progress"))
  ) {
    const days = Number(settings.continue_after_days) || 3;
    const week = isoWeek(now);
    const { rows } = await db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (wp.user_id) wp.user_id, wp.video_id, wp.position_seconds,
                wp.duration_seconds, wp.updated_at, COALESCE(wp.completed, FALSE) AS completed
           FROM watch_progress wp
          ORDER BY wp.user_id, wp.updated_at DESC
       )
       SELECT u.id, u.name, u.email, v.id AS video_id, v.title, ${thumbCol} AS thumbnail_url,
              l.position_seconds, l.duration_seconds
         FROM latest l
         JOIN users u ON u.id::text = l.user_id::text
         JOIN videos v ON v.id = l.video_id
        WHERE ${PUBLIC_VIDEO}
          AND u.email IS NOT NULL AND u.email <> ''
          AND NOT l.completed
          AND l.duration_seconds > 0
          AND l.position_seconds >= l.duration_seconds * 0.10
          AND l.position_seconds <= l.duration_seconds * 0.90
          AND l.updated_at <= $1::timestamptz - ($2::int * INTERVAL '1 day')
          AND l.updated_at >  $1::timestamptz - (($2::int + 7) * INTERVAL '1 day')
          AND ${NOT_DONE(`'cw:${week}:' || lower(u.email)`)}
        ORDER BY l.updated_at LIMIT $3`,
      [now, days, left],
    );
    for (const r of rows) {
      const leftMin = Math.max(
        1,
        Math.round((r.duration_seconds - r.position_seconds) / 60),
      );
      await send(
        "continue_watching",
        r,
        {
          video_title: r.title || "your video",
          minutes_left: String(leftMin),
          video_url: T.sitePage(
            `watch/${r.video_id}?t=${Math.floor(r.position_seconds)}`,
          ),
          thumbnail_url: thumb(r.thumbnail_url),
        },
        `cw:${week}:${r.email.toLowerCase()}`,
      );
    }
  }

  // ── 5. We miss you ──
  if (on("we_miss_you") && left > 0) {
    const days = Number(settings.miss_after_days) || 30;
    const hasWp = await tableExists("watch_progress");
    const hasUe = await tableExists("usage_events");
    const activity = [
      "u.created_at",
      hasWp
        ? "(SELECT MAX(wp.updated_at) FROM watch_progress wp WHERE wp.user_id::text = u.id::text)"
        : null,
      hasUe
        ? "(SELECT MAX(ue.created_at) FROM usage_events ue WHERE ue.user_id = u.id)"
        : null,
    ].filter(Boolean);
    const { rows } = await db.query(
      `SELECT * FROM (
         SELECT u.id, u.name, u.email, GREATEST(${activity.join(", ")}) AS last_active
           FROM users u
          WHERE u.email IS NOT NULL AND u.email <> ''
       ) x
       WHERE x.last_active <= $1::timestamptz - ($2::int * INTERVAL '1 day')
         AND x.last_active >  $1::timestamptz - (($2::int + 14) * INTERVAL '1 day')
         AND ${NOT_DONE("'miss:' || lower(x.email) || ':' || to_char(x.last_active, 'YYYY-MM-DD')")}
       ORDER BY x.last_active LIMIT $3`,
      [now, days, left],
    );
    if (rows.length) {
      const { rows: vids } = await db.query(
        `SELECT v.id, v.title, ${thumbCol} AS thumbnail_url, ${durCol} AS duration_seconds
           FROM videos v WHERE ${PUBLIC_VIDEO}
          ORDER BY ${pubCol} DESC LIMIT 3`,
      );
      const items = vids.map(videoItem);
      for (const r of rows) {
        const day = new Date(r.last_active).toISOString().slice(0, 10);
        await send(
          "we_miss_you",
          r,
          { _items: items },
          `miss:${r.email.toLowerCase()}:${day}`,
        );
      }
    }
  }

  return out;
}

let timer = null;
let running = false;
function startEmailAutomationWorker() {
  if (String(process.env.EMAIL_AUTOMATIONS || "").toLowerCase() === "off") {
    console.log("[emailAutomations] off (EMAIL_AUTOMATIONS=off)");
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runOnce();
      const total = Object.values(r).reduce((n, x) => n + (x.sent || 0), 0);
      if (total) console.log("[emailAutomations] sent:", JSON.stringify(r));
    } catch (e) {
      console.warn("[emailAutomations] run failed:", e?.message || e);
    } finally {
      running = false;
    }
  };
  setTimeout(tick, 60 * 1000); // first run a minute after start-up
  timer = setInterval(tick, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log("[emailAutomations] worker started (every 10 min)");
}

module.exports = { runOnce, startEmailAutomationWorker, localNow, isoWeek };
