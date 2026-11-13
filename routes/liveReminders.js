// server-api/routes/liveReminders.js
//
// Release 2.2 Part B — "Notify me" before live services (email).
//
//   POST /api/live-reminders               { email? } subscribe (members: their account email)
//   GET  /api/live-reminders/me            is the signed-in member subscribed?
//   DELETE /api/live-reminders/me          member: stop reminders
//   GET  /api/live-reminders/unsubscribe?token=…   link in every email
//
// Sender: every 5 minutes, Calendar live events starting within 30 minutes get
// one email per subscriber — once per event (recorded in live_reminder_sends).
// Turn off with LIVE_REMINDERS=off.

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const { tokenUserId } = require("./liveChat");

const router = express.Router();
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z]{2,}$/;

const hits = new Map();
function limited(key) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
  list.push(now);
  hits.set(key, list);
  return list.length > 5;
}
const ipOf = (req) =>
  String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "")
    .split(",")[0]
    .trim();
const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

router.post("/", express.json({ limit: "8kb" }), async (req, res) => {
  try {
    if (String(req.body?.website || "").trim()) return res.json({ ok: true }); // spam trap
    if (limited(ipOf(req)))
      return res
        .status(429)
        .json({ ok: false, error: "Too many requests. Try again later." });
    const userId = tokenUserId(req.headers.authorization || "");
    let email = String(req.body?.email || "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    if (userId) {
      const { rows } = await db.query("SELECT email FROM users WHERE id = $1", [
        userId,
      ]);
      if (rows[0]?.email) email = String(rows[0].email).toLowerCase();
    }
    if (!EMAIL_RE.test(email))
      return res
        .status(400)
        .json({ ok: false, error: "Enter a valid email address." });
    await db.query(
      `INSERT INTO live_reminders (email, user_id, token) VALUES ($1, $2, $3)
       ON CONFLICT ((lower(email))) DO UPDATE SET unsubscribed_at = NULL,
         user_id = COALESCE(EXCLUDED.user_id, live_reminders.user_id)`,
      [email, userId, crypto.randomBytes(24).toString("hex")],
    );
    res.json({ ok: true, email: userId ? email : undefined });
  } catch (e) {
    if (String(e?.code) === "42P01")
      return res
        .status(503)
        .json({
          ok: false,
          error:
            "Reminders are not set up yet (run the 20261113_10 migration).",
        });
    console.error("[reminders] subscribe failed:", e);
    res.status(500).json({ ok: false, error: "Could not save your reminder." });
  }
});

router.get("/me", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const userId = tokenUserId(req.headers.authorization || "");
  if (!userId) return res.json({ ok: true, subscribed: false });
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM live_reminders r JOIN users u ON lower(u.email) = lower(r.email)
        WHERE u.id = $1 AND r.unsubscribed_at IS NULL`,
      [userId],
    );
    res.json({ ok: true, subscribed: rows.length > 0 });
  } catch {
    res.json({ ok: true, subscribed: false });
  }
});

router.delete("/me", async (req, res) => {
  const userId = tokenUserId(req.headers.authorization || "");
  if (!userId)
    return res.status(401).json({ ok: false, error: "Sign in first." });
  try {
    await db.query(
      `UPDATE live_reminders r SET unsubscribed_at = NOW() FROM users u
        WHERE u.id = $1 AND lower(u.email) = lower(r.email)`,
      [userId],
    );
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false, error: "Could not update." });
  }
});

router.get("/unsubscribe", async (req, res) => {
  const token = String(req.query.token || "")
    .replace(/[^a-f0-9]/g, "")
    .slice(0, 64);
  let done = false;
  if (token) {
    try {
      const { rowCount } = await db.query(
        "UPDATE live_reminders SET unsubscribed_at = NOW() WHERE token = $1",
        [token],
      );
      done = rowCount > 0;
    } catch {
      done = false;
    }
  }
  res
    .status(done ? 200 : 404)
    .type("html")
    .send(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live reminders</title>` +
        `<body style="font-family:system-ui,sans-serif;background:#0b0b10;color:#f4f4f5;display:grid;place-items:center;min-height:90vh;margin:0">` +
        `<main style="max-width:480px;padding:24px;text-align:center"><h1 style="font-size:22px">${
          done ? "You're unsubscribed" : "Link not recognized"
        }</h1><p>${done ? "You won't receive live service reminders anymore." : "This unsubscribe link is not valid or was already used."}</p></main></body>`,
    );
});

// ---------- sender ----------
async function sendDueReminders({
  now = new Date(),
  siteUrl = process.env.REACT_APP_SITE_URL || process.env.PUBLIC_SITE_URL || "",
  apiBase = process.env.PUBLIC_API_URL || "",
  send,
} = {}) {
  // Every live service (one-off or repeating) starting within 30 minutes.
  let events = [];
  try {
    const schedule = require("../lib/liveSchedule");
    events = (
      await schedule.upcoming(
        new Date(now.getTime() + 1000),
        new Date(now.getTime() + 30 * 60000),
      )
    ).slice(0, 5);
  } catch {
    return { sent: 0, events: 0 };
  }
  let total = 0;
  for (const ev of events) {
    const key = `${ev.key}:${ev.start_at.toISOString()}`;
    // Claim the event first, so two servers or a restart never send twice.
    const { rowCount } = await db.query(
      "INSERT INTO live_reminder_sends (event_key) VALUES ($1) ON CONFLICT DO NOTHING",
      [key],
    );
    if (!rowCount) continue;
    const { rows: subs } = await db.query(
      "SELECT email, token FROM live_reminders WHERE unsubscribed_at IS NULL ORDER BY id LIMIT 5000",
    );
    const sendFn = send || require("../services/email").sendEmail;
    const when = ev.start_at.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: process.env.CALENDAR_TIMEZONE || "America/New_York",
    });
    const title = ev.title || "Live service";
    const watch = siteUrl
      ? `${siteUrl.replace(/\/+$/, "")}/#/live-streaming`
      : "";
    let count = 0;
    for (const s of subs) {
      const unsub = `${apiBase.replace(/\/+$/, "")}/api/live-reminders/unsubscribe?token=${s.token}`;
      try {
        await sendFn({
          to: s.email,
          subject: `Starting soon: ${title}`,
          text: `${title} starts at ${when}.${watch ? `\n\nWatch live: ${watch}` : ""}\n\nStop these reminders: ${unsub}`,
          html: `<p><strong>${esc(title)}</strong> starts at ${esc(when)}.</p>${
            watch ? `<p><a href="${esc(watch)}">Watch live</a></p>` : ""
          }<p style="font-size:12px;color:#666"><a href="${esc(unsub)}">Stop live service reminders</a></p>`,
        });
        count += 1;
      } catch (e) {
        console.warn("[reminders] email failed:", e?.message || e);
      }
    }
    await db.query(
      "UPDATE live_reminder_sends SET sent_count = $2 WHERE event_key = $1",
      [key, count],
    );
    total += count;
  }
  return { sent: total, events: events.length };
}

function startReminderWorker() {
  if (String(process.env.LIVE_REMINDERS || "").toLowerCase() === "off")
    return null;
  const tick = () =>
    sendDueReminders().catch((e) => {
      if (String(e?.code) !== "42P01")
        console.warn("[reminders] run failed:", e?.message || e);
    });
  const t = setInterval(tick, 5 * 60 * 1000);
  t.unref?.();
  setTimeout(tick, 30 * 1000).unref?.();
  return t;
}

module.exports = { router, sendDueReminders, startReminderWorker };
