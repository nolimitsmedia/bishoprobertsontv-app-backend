// server-api/services/emailTemplates.js
//
// Automated emails, Package A:
//  - CATALOG: every automated email, its default wording and fill-in fields
//  - wording the admin edits (email_automations), on/off switches
//  - one branded design (logo + brand colour from Site Settings)
//  - email preferences + one-click unsubscribe (email_preferences)
//  - send log, which also stops duplicates (email_send_log)
//
// sendTemplated(key, { to, vars, ... }) is how the site sends these emails.
// It goes through services/emailTransport.js (the account connected in
// Admin › Integration › Email).

const crypto = require("crypto");
const db = require("../db");
const transport = require("./emailTransport");

/* ───────────────────────── links ───────────────────────── */

const DEFAULT_SITE = "https://nolimitsmedia.github.io/bishoprobertsontv-app";
const s = (v) => (v == null ? "" : String(v)).trim();

// The public website (GitHub Pages / custom domain). Pages are hash routes.
function siteUrl() {
  return (
    s(process.env.PUBLIC_SITE_URL) ||
    s(process.env.REACT_APP_SITE_URL) ||
    DEFAULT_SITE
  ).replace(/\/+$/, "");
}
function sitePage(route) {
  return `${siteUrl()}/#/${String(route || "").replace(/^\/+/, "")}`;
}
// The API (Render), for one-click unsubscribe.
function apiUrl() {
  return (
    s(process.env.PUBLIC_API_URL) ||
    s(process.env.PUBLIC_BASE_URL) ||
    s(process.env.API_BASE) ||
    ""
  ).replace(/\/+$/, "");
}

/* ───────────────────────── catalog ───────────────────────── */
// category:
//   essential – always sent (password reset, receipts); wording editable
//   account   – about the person's own account (welcome); can be turned off
//   updates   – optional; viewers can unsubscribe (list = their preference)
//   office    – alerts to the ministry office
// Body: plain text, a blank line between paragraphs, {fields} filled in.

const CATALOG = [
  {
    key: "welcome",
    name: "Welcome",
    category: "account",
    when: "Right after someone creates an account.",
    default_on: true,
    subject: "Welcome to {site_name}, {first_name}",
    heading: "Welcome, {first_name}!",
    body:
      "We’re so glad you’re here. Your account is ready, and you can start watching sermons, teachings and live services today.\n\n" +
      "Tip: add {site_name} to your phone’s home screen and it opens like an app, one tap away.",
    button: "Start watching",
    action: "site",
    fields: ["first_name", "name", "email", "site_name", "site_url"],
  },
  {
    key: "password_reset",
    name: "Password reset",
    category: "essential",
    when: "When someone asks to reset their password.",
    default_on: true,
    subject: "Reset your {site_name} password",
    heading: "Reset your password",
    body:
      "Hi {first_name},\n\n" +
      "We received a request to reset the password for your {site_name} account. Press the button to choose a new password. The link works for 24 hours.\n\n" +
      "If you didn’t ask for this, you can ignore this email — your password won’t change.",
    button: "Choose a new password",
    action: "reset_url",
    fields: ["first_name", "name", "email", "site_name", "reset_url"],
  },
  {
    key: "subscription_receipt",
    name: "Subscription receipt",
    category: "essential",
    when: "When a subscription payment goes through.",
    default_on: true,
    subject: "Your {plan_name} subscription is active",
    heading: "Thank you, {first_name}!",
    body:
      "Your {plan_name} subscription is active.\n\n" +
      "Amount: {amount} {interval_label}\n\n" +
      "Thank you for supporting this ministry. You now have full access to everything on {site_name}.",
    button: "Start watching",
    action: "site",
    fields: [
      "first_name",
      "name",
      "email",
      "plan_name",
      "amount",
      "interval_label",
      "site_name",
      "invoice_url",
    ],
  },
  {
    key: "live_reminder",
    name: "Live service reminder",
    category: "updates",
    list: "live",
    when: "About 30 minutes before a live service, to people who tapped “Notify me”.",
    default_on: true,
    subject: "Starting soon: {event_title}",
    heading: "{event_title} starts soon",
    body: "{event_title} begins at {start_time}. Join us live — we’ll see you there!",
    button: "Watch live",
    action: "watch_url",
    fields: ["event_title", "start_time", "watch_url", "site_name"],
  },
  {
    key: "office_new_signup",
    name: "New sign-up alert (to the office)",
    category: "office",
    when: "When someone creates an account. Goes to the office notifications address.",
    default_on: true,
    subject: "New sign-up: {member_name}",
    heading: "New sign-up",
    body: "{member_name} ({member_email}) just created an account on {site_name}.",
    button: "",
    action: "",
    fields: ["member_name", "member_email", "site_name"],
  },
  {
    key: "office_new_subscriber",
    name: "New subscriber alert (to the office)",
    category: "office",
    when: "When someone starts a paid subscription. Goes to the office notifications address.",
    default_on: true,
    subject: "New subscription: {member_name} → {plan_name}",
    heading: "New subscription",
    body: "{member_name} ({member_email}) subscribed to {plan_name}: {amount} {interval_label}.",
    button: "",
    action: "",
    fields: [
      "member_name",
      "member_email",
      "plan_name",
      "amount",
      "interval_label",
      "site_name",
    ],
  },

  /* ── Package B: automations (all start OFF) ── */
  {
    key: "welcome_followup",
    name: "Welcome follow-up",
    category: "updates",
    list: "news",
    when: "3 days after someone creates an account (people who signed up in the last week).",
    default_on: false,
    subject: "Getting the most from {site_name}",
    heading: "Glad you’re with us, {first_name}",
    body:
      "Here are three ways to stay close to the Word this week:\n\n" +
      "Watch on any screen — your phone, tablet, computer or TV. On your phone, add {site_name} to your home screen and it opens like an app.\n\n" +
      "Join us live — tap “Notify me” on the Live page and we’ll email you before each service.\n\n" +
      "Pick up where you left off — every message remembers where you stopped.",
    button: "Explore the messages",
    action: "site_url",
    fields: ["first_name", "name", "site_name", "site_url"],
  },
  {
    key: "new_video",
    name: "New sermon alert",
    category: "updates",
    list: "updates",
    when: "When a new video is published (sent within 2 days; at most 3 a day per person). Use this or the weekly roundup.",
    default_on: false,
    subject: "New: {video_title}",
    heading: "{video_title}",
    body: "A new message is now on {site_name}.\n\n{video_description}",
    button: "Watch now",
    action: "video_url",
    image: "thumbnail_url",
    fields: [
      "first_name",
      "video_title",
      "video_description",
      "video_url",
      "site_name",
    ],
  },
  {
    key: "weekly_roundup",
    name: "Weekly roundup",
    category: "updates",
    list: "updates",
    when: "Once a week (day and time in Settings), listing the videos added that week. Skipped in weeks with nothing new.",
    default_on: false,
    subject: "This week on {site_name}",
    heading: "New this week",
    body: "Here’s what was added this week, {first_name}. Take a moment and be refreshed.",
    button: "See everything",
    action: "site_url",
    items: true,
    fields: ["first_name", "video_count", "site_name", "site_url"],
  },
  {
    key: "continue_watching",
    name: "Continue watching",
    category: "updates",
    list: "activity",
    when: "When someone left a video part-way and hasn’t watched for a few days (Settings). At most once a week.",
    default_on: false,
    subject: "Pick up where you left off: {video_title}",
    heading: "Ready when you are",
    body: "You were part-way through “{video_title}” — about {minutes_left} minutes left. Press the button and it starts right where you stopped.",
    button: "Keep watching",
    action: "video_url",
    image: "thumbnail_url",
    fields: [
      "first_name",
      "video_title",
      "minutes_left",
      "video_url",
      "site_name",
    ],
  },
  {
    key: "we_miss_you",
    name: "We miss you",
    category: "updates",
    list: "activity",
    when: "When a member hasn’t visited for a while (Settings). Once per absence.",
    default_on: false,
    subject: "We miss you, {first_name}",
    heading: "We miss you, {first_name}",
    body: "It’s been a little while since your last visit. Here are some of the newest messages — come back and be encouraged.",
    button: "Come back and watch",
    action: "site_url",
    items: true,
    fields: ["first_name", "site_name", "site_url"],
  },

  /* ── Billing (sent by monetization, Release 2.1; off until then) ── */
  {
    key: "trial_ending",
    name: "Free trial ending",
    category: "billing",
    when: "3 days before a free trial ends.",
    default_on: false,
    subject: "Your free trial ends on {trial_end_date}",
    heading: "Your trial ends soon",
    body: "Hi {first_name}, your free trial of {plan_name} ends on {trial_end_date}. After that your subscription continues at {amount} {interval_label} — nothing for you to do.\n\nIf you’d rather not continue, you can cancel any time before then.",
    button: "Manage subscription",
    action: "billing_url",
    fields: [
      "first_name",
      "plan_name",
      "trial_end_date",
      "amount",
      "interval_label",
      "billing_url",
      "site_name",
    ],
  },
  {
    key: "payment_failed",
    name: "Payment failed",
    category: "billing",
    when: "When a subscription payment doesn’t go through.",
    default_on: false,
    subject: "Action needed: your payment didn’t go through",
    heading: "Please update your payment",
    body: "Hi {first_name}, we couldn’t take the {amount} payment for your {plan_name} subscription. Please update your card so you keep full access.",
    button: "Update payment",
    action: "billing_url",
    fields: ["first_name", "plan_name", "amount", "billing_url", "site_name"],
  },
  {
    key: "renewal_reminder",
    name: "Renewal reminder",
    category: "billing",
    when: "7 days before a yearly subscription renews.",
    default_on: false,
    subject: "Your {plan_name} subscription renews on {renewal_date}",
    heading: "Renewal coming up",
    body: "Hi {first_name}, your {plan_name} subscription renews on {renewal_date} for {amount}. Thank you for standing with this ministry.",
    button: "Manage subscription",
    action: "billing_url",
    fields: [
      "first_name",
      "plan_name",
      "renewal_date",
      "amount",
      "billing_url",
      "site_name",
    ],
  },
  {
    key: "subscription_cancelled",
    name: "Subscription cancelled",
    category: "billing",
    when: "When someone cancels their subscription.",
    default_on: false,
    subject: "Your subscription has been cancelled",
    heading: "Sorry to see you go, {first_name}",
    body: "Your {plan_name} subscription is cancelled. You still have full access until {access_until}.\n\nYou’re welcome back any time.",
    button: "Restart my subscription",
    action: "billing_url",
    fields: [
      "first_name",
      "plan_name",
      "access_until",
      "billing_url",
      "site_name",
    ],
  },
  {
    key: "gift_received",
    name: "Gift subscription received",
    category: "billing",
    when: "When someone gives a subscription as a gift.",
    default_on: false,
    subject: "{gift_from} gave you {site_name}",
    heading: "You’ve received a gift!",
    body: "{gift_from} gave you a {plan_name} subscription to {site_name}.\n\n{gift_message}",
    button: "Claim your gift",
    action: "redeem_url",
    fields: [
      "first_name",
      "gift_from",
      "plan_name",
      "gift_message",
      "redeem_url",
      "site_name",
    ],
  },
];
const BY_KEY = Object.fromEntries(CATALOG.map((t) => [t.key, t]));

// Optional email lists a viewer can turn off on the preferences page.
const LISTS = {
  live: {
    label: "Live service reminders",
    help: "A short email before live services you asked to be reminded about.",
  },
  updates: {
    label: "New sermons and series",
    help: "When new teachings are added.",
  },
  activity: {
    label: "Continue watching and reminders",
    help: "A nudge when you’ve left a video half-finished.",
  },
  news: {
    label: "News and announcements",
    help: "Occasional emails from the ministry.",
  },
};

const FIELD_LABELS = {
  first_name: "First name",
  name: "Full name",
  email: "Email address",
  site_name: "Site name",
  site_url: "Website link",
  reset_url: "Reset link",
  plan_name: "Plan name",
  amount: "Amount",
  interval_label: "Billing period",
  invoice_url: "Invoice link",
  event_title: "Service title",
  start_time: "Start time",
  watch_url: "Watch link",
  member_name: "Member name",
  member_email: "Member email",
  video_title: "Video title",
  video_description: "Video description",
  video_url: "Video link",
  video_count: "Number of videos",
  minutes_left: "Minutes left",
  trial_end_date: "Trial end date",
  renewal_date: "Renewal date",
  access_until: "Access until",
  billing_url: "Billing page link",
  gift_from: "Gift from",
  gift_message: "Gift message",
  redeem_url: "Gift link",
};

const SAMPLE = {
  first_name: "Grace",
  name: "Grace Johnson",
  email: "grace@example.com",
  reset_url: "https://example.com/reset",
  plan_name: "Monthly Partner",
  amount: "$9.99",
  interval_label: "per month",
  invoice_url: "",
  event_title: "Sunday Worship Service",
  start_time: "11:00 AM EST",
  watch_url: "",
  member_name: "Grace Johnson",
  member_email: "grace@example.com",
  video_title: "Walking in Faith, Part 1",
  video_description:
    "Bishop Robertson opens a new series on trusting God in every season.",
  video_count: "3",
  minutes_left: "24",
  trial_end_date: "December 3",
  renewal_date: "December 10",
  access_until: "December 31",
  gift_from: "Michael Johnson",
  gift_message: "Thinking of you this season!",
  _items: [
    { title: "Walking in Faith, Part 1", subtitle: "Sunday service · 52 min" },
    { title: "The Power of Prayer", subtitle: "Bible study · 38 min" },
    { title: "Christmas Hope", subtitle: "Special · 45 min" },
  ],
};

/* ───────────────────────── schema ───────────────────────── */

let ready = null;
function ensureSchema() {
  if (!ready) {
    ready = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS email_automations (
          key TEXT PRIMARY KEY,
          enabled BOOLEAN,
          subject TEXT,
          heading TEXT,
          body TEXT,
          button TEXT,
          updated_by BIGINT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      // When an automation was last switched on: it never reaches back before that.
      await db.query(
        "ALTER TABLE email_automations ADD COLUMN IF NOT EXISTS enabled_at TIMESTAMPTZ",
      );
      await db.query(`
        CREATE TABLE IF NOT EXISTS email_settings (
          key TEXT PRIMARY KEY,
          value TEXT,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS email_preferences (
          email TEXT PRIMARY KEY,
          token TEXT UNIQUE NOT NULL,
          unsubscribed_all BOOLEAN NOT NULL DEFAULT FALSE,
          lists JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(`
        CREATE TABLE IF NOT EXISTS email_send_log (
          id BIGSERIAL PRIMARY KEY,
          template_key TEXT NOT NULL,
          email TEXT NOT NULL,
          subject TEXT,
          status TEXT NOT NULL,          -- sent | failed | skipped
          detail TEXT,
          provider TEXT,
          dedupe_key TEXT UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
      await db.query(
        "CREATE INDEX IF NOT EXISTS idx_email_send_log_created ON email_send_log (created_at DESC)",
      );
    })().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

/* ───────────────────────── settings & branding ───────────────────────── */

async function getSettings() {
  await ensureSchema();
  const { rows } = await db.query("SELECT key, value FROM email_settings");
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows) out[r.key] = r.value || "";
  return out;
}

const SETTING_DEFAULTS = {
  footer_address: "",
  footer_note: "",
  roundup_day: "mon", // weekly roundup day (sun…sat)
  roundup_hour: "9", // local hour 0–23 (CALENDAR_TIMEZONE)
  continue_after_days: "3",
  miss_after_days: "30",
};
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function cleanSetting(k, v) {
  const t = s(v);
  if (k === "roundup_day") return DAYS.includes(t) ? t : null;
  if (k === "roundup_hour")
    return /^\d+$/.test(t) && +t >= 0 && +t <= 23 ? String(+t) : null;
  if (k === "continue_after_days")
    return /^\d+$/.test(t) && +t >= 1 && +t <= 30 ? String(+t) : null;
  if (k === "miss_after_days")
    return /^\d+$/.test(t) && +t >= 14 && +t <= 365 ? String(+t) : null;
  return t.slice(0, 400);
}

async function saveSettings(patch) {
  await ensureSchema();
  for (const k of Object.keys(SETTING_DEFAULTS)) {
    if (patch[k] === undefined) continue;
    const val = cleanSetting(k, patch[k]);
    if (val === null) throw new Error(`Invalid value for ${k}`);
    patch = { ...patch, [k]: val };
    await db.query(
      `INSERT INTO email_settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [k, s(patch[k]).slice(0, 400)],
    );
  }
  return getSettings();
}

const HEX = /^#[0-9a-f]{6}$/i;
let brandCache = { at: 0, value: null };
async function getBrand() {
  if (brandCache.value && Date.now() - brandCache.at < 60000)
    return brandCache.value;
  let row = {};
  try {
    const r = await db.query(
      "SELECT site_name, brand_color, logo_url FROM site_settings ORDER BY id DESC LIMIT 1",
    );
    row = r.rows[0] || {};
  } catch {
    /* table may not exist yet */
  }
  let logo = s(row.logo_url);
  if (logo && !/^https?:\/\//i.test(logo)) {
    const base = logo.startsWith("/uploads") ? apiUrl() : siteUrl();
    logo = base ? `${base}/${logo.replace(/^\/+/, "")}` : "";
  }
  // Email inboxes need a full https address; default: the site's wide logo.
  if (!/^https:\/\//i.test(logo)) logo = `${siteUrl()}/bishop-robertson-tv.png`;
  const color = HEX.test(s(row.brand_color)) ? s(row.brand_color) : "#7c3aed";
  const value = {
    site_name: s(row.site_name) || "BishopRobertson.TV",
    color,
    logo,
  };
  brandCache = { at: Date.now(), value };
  return value;
}

/* ───────────────────────── wording ───────────────────────── */

async function getTemplate(key) {
  const def = BY_KEY[key];
  if (!def) throw new Error(`Unknown email: ${key}`);
  await ensureSchema();
  const { rows } = await db.query(
    "SELECT * FROM email_automations WHERE key = $1",
    [key],
  );
  const r = rows[0] || {};
  return {
    ...def,
    enabled:
      def.category === "essential" ? true : (r.enabled ?? def.default_on),
    subject: s(r.subject) || def.subject,
    heading: s(r.heading) || def.heading,
    body: s(r.body) || def.body,
    button: r.button == null ? def.button : s(r.button),
    customized: !!(r.subject || r.heading || r.body || r.button != null),
    enabled_at: r.enabled_at || null,
    updated_at: r.updated_at || null,
  };
}

async function listTemplates() {
  return Promise.all(CATALOG.map((t) => getTemplate(t.key)));
}

async function saveTemplate(key, patch, userId) {
  const def = BY_KEY[key];
  if (!def) throw new Error(`Unknown email: ${key}`);
  await ensureSchema();
  if (patch.reset) {
    await db.query("DELETE FROM email_automations WHERE key = $1", [key]);
    if (patch.enabled !== undefined && def.category !== "essential")
      await db.query(
        "INSERT INTO email_automations (key, enabled, updated_by, enabled_at) VALUES ($1,$2,$3, CASE WHEN $2 THEN NOW() END)",
        [key, !!patch.enabled, userId || null],
      );
    return getTemplate(key);
  }
  const val = (k, max) =>
    (patch[k] == null ? "" : String(patch[k]).trim()).slice(0, max);
  const subject = patch.subject !== undefined ? val("subject", 200) : null;
  const heading = patch.heading !== undefined ? val("heading", 200) : null;
  const body = patch.body !== undefined ? val("body", 8000) : null;
  const button = patch.button !== undefined ? val("button", 60) : null;
  if (subject !== null && !subject)
    throw new Error("The subject can’t be empty.");
  if (body !== null && !body) throw new Error("The message can’t be empty.");
  const enabled =
    def.category === "essential"
      ? null
      : patch.enabled === undefined
        ? null
        : !!patch.enabled;
  await db.query(
    `INSERT INTO email_automations (key, enabled, subject, heading, body, button, updated_by, updated_at, enabled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), CASE WHEN $2 IS TRUE THEN NOW() END)
     ON CONFLICT (key) DO UPDATE SET
       enabled = COALESCE($2, email_automations.enabled),
       enabled_at = CASE WHEN $2 IS TRUE AND email_automations.enabled IS NOT TRUE THEN NOW()
                         ELSE email_automations.enabled_at END,
       subject = COALESCE($3, email_automations.subject),
       heading = COALESCE($4, email_automations.heading),
       body    = COALESCE($5, email_automations.body),
       button  = CASE WHEN $8 THEN $6 ELSE email_automations.button END,
       updated_by = $7, updated_at = NOW()`,
    [
      key,
      enabled,
      subject,
      heading,
      body,
      button,
      userId || null,
      patch.button !== undefined,
    ],
  );
  return getTemplate(key);
}

/* ───────────────────────── rendering ───────────────────────── */

const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

function fill(text, vars) {
  return String(text || "").replace(/\{([a-z_]+)\}/g, (m, k) =>
    vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : "",
  );
}

// Light text on the brand colour, or dark text if the colour is pale.
function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? "#111111" : "#ffffff";
}

// Branded HTML + plain-text version.
function renderEmail({
  tpl,
  vars,
  brand,
  settings,
  unsubscribeUrl,
  preferencesUrl,
  reason,
}) {
  const subject = fill(tpl.subject, vars).replace(/\s+/g, " ").trim();
  const heading = fill(tpl.heading, vars).trim();
  const paragraphs = fill(tpl.body, vars)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const buttonLabel = fill(tpl.button || "", vars).trim();
  const actionUrl = tpl.action ? s(vars[tpl.action]) : "";
  const showButton = !!(buttonLabel && /^https?:\/\//i.test(actionUrl));
  const footerAddress = s(settings.footer_address);
  const footerNote = s(settings.footer_note);
  const btnText = onColor(brand.color);
  const image =
    tpl.image && /^https:\/\//i.test(s(vars[tpl.image]))
      ? s(vars[tpl.image])
      : "";
  const items =
    tpl.items && Array.isArray(vars._items) ? vars._items.slice(0, 8) : [];
  const itemsHtml = items.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px">${items
        .map((it) => {
          const url = /^https?:\/\//i.test(s(it.url)) ? s(it.url) : "";
          const img = /^https:\/\//i.test(s(it.image)) ? s(it.image) : "";
          const title = esc(it.title || "");
          return `<tr><td style="padding:8px 0;border-bottom:1px solid #ebe7f0">
<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
${img ? `<td width="128" valign="top" style="padding-right:14px">${url ? `<a href="${esc(url)}">` : ""}<img src="${esc(img)}" width="128" alt="" style="display:block;width:128px;height:auto;border-radius:8px;border:0">${url ? "</a>" : ""}</td>` : ""}
<td valign="top" style="font-family:Arial,Helvetica,sans-serif">
<p style="margin:0 0 4px;font-size:16px;font-weight:700;line-height:1.35">${url ? `<a href="${esc(url)}" style="color:#16111c;text-decoration:none">${title}</a>` : `<span style="color:#16111c">${title}</span>`}</p>
${it.subtitle ? `<p style="margin:0;font-size:13.5px;color:#6b6475">${esc(it.subtitle)}</p>` : ""}
</td></tr></table></td></tr>`;
        })
        .join("")}</table>`
    : "";

  const pHtml = paragraphs
    .map(
      (p) =>
        `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#2b2533">${esc(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("");
  const footerLines = [
    footerNote ? esc(footerNote) : "",
    reason ? esc(reason) : "",
    footerAddress ? esc(footerAddress) : "",
    unsubscribeUrl || preferencesUrl
      ? [
          preferencesUrl
            ? `<a href="${esc(preferencesUrl)}" style="color:#6b6475;text-decoration:underline">Email preferences</a>`
            : "",
          unsubscribeUrl
            ? `<a href="${esc(unsubscribeUrl)}" style="color:#6b6475;text-decoration:underline">Unsubscribe</a>`
            : "",
        ]
          .filter(Boolean)
          .join(" &nbsp;·&nbsp; ")
      : "",
  ].filter(Boolean);

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f3f1f6;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(paragraphs[0] || heading).slice(0, 140)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1f6">
<tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td align="center" style="background:#0b0710;border-radius:14px 14px 0 0;padding:22px 24px">
      <a href="${esc(siteUrl())}" style="text-decoration:none"><img src="${esc(brand.logo)}" alt="${esc(brand.site_name)}" width="220" style="display:block;width:220px;max-width:100%;height:auto;border:0;color:#ffffff;font:700 20px Arial,sans-serif"></a>
    </td></tr>
    <tr><td style="background:#ffffff;padding:30px 28px 14px;font-family:Arial,Helvetica,sans-serif">
      ${image ? `<img src="${esc(image)}" alt="" width="504" style="display:block;width:100%;max-width:504px;height:auto;border-radius:10px;margin:0 0 20px;border:0">` : ""}
      ${heading ? `<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;color:#16111c;font-weight:700">${esc(heading)}</h1>` : ""}
      ${pHtml}
      ${itemsHtml}
      ${
        showButton
          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px"><tr><td style="border-radius:999px;background:${brand.color}">
        <a href="${esc(actionUrl)}" style="display:inline-block;padding:14px 26px;font:700 16px Arial,Helvetica,sans-serif;color:${btnText};text-decoration:none;border-radius:999px">${esc(buttonLabel)}</a>
      </td></tr></table>`
          : ""
      }
    </td></tr>
    <tr><td style="background:#ffffff;border-radius:0 0 14px 14px;padding:0 28px 24px;font-family:Arial,Helvetica,sans-serif">
      <p style="margin:0;padding-top:16px;border-top:1px solid #ebe7f0;font-size:12.5px;line-height:1.7;color:#6b6475">${footerLines.join("<br>") || esc(brand.site_name)}</p>
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    heading,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...items.map((it) => `- ${it.title}${it.url ? `: ${it.url}` : ""}`),
    items.length ? "" : null,
    showButton ? `${buttonLabel}: ${actionUrl}\n` : "",
    "—",
    footerNote,
    reason,
    footerAddress,
    preferencesUrl ? `Email preferences: ${preferencesUrl}` : "",
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : "",
  ]
    .filter((l) => l !== undefined && l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { subject, html, text };
}

/* ───────────────────────── preferences ───────────────────────── */

const normEmail = (e) => s(e).toLowerCase();

async function prefsFor(email, { create = true } = {}) {
  await ensureSchema();
  const em = normEmail(email);
  if (!em) return null;
  let { rows } = await db.query(
    "SELECT * FROM email_preferences WHERE email = $1",
    [em],
  );
  if (!rows[0] && create) {
    const token = crypto.randomBytes(24).toString("hex");
    ({ rows } = await db.query(
      `INSERT INTO email_preferences (email, token) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING *`,
      [em, token],
    ));
  }
  return rows[0] || null;
}

async function prefsByToken(token) {
  await ensureSchema();
  const t = s(token);
  if (!/^[a-f0-9]{32,64}$/.test(t)) return null;
  const { rows } = await db.query(
    "SELECT * FROM email_preferences WHERE token = $1",
    [t],
  );
  return rows[0] || null;
}

function wants(prefs, list) {
  if (!prefs) return true;
  if (prefs.unsubscribed_all) return false;
  return prefs.lists?.[list] !== false;
}

// Live reminders keep their own sign-up list; keep it in step.
async function syncLiveList(email, on) {
  try {
    await db.query(
      `UPDATE live_reminders SET unsubscribed_at = ${on ? "NULL" : "COALESCE(unsubscribed_at, NOW())"}
        WHERE lower(email) = lower($1)`,
      [email],
    );
  } catch {
    /* table may not exist */
  }
}

async function liveSignedUp(email) {
  try {
    const { rows } = await db.query(
      "SELECT unsubscribed_at FROM live_reminders WHERE lower(email) = lower($1) LIMIT 1",
      [email],
    );
    if (!rows[0]) return null; // never signed up
    return rows[0].unsubscribed_at == null;
  } catch {
    return null;
  }
}

async function updatePrefs(token, { lists, unsubscribed_all }) {
  const p = await prefsByToken(token);
  if (!p) return null;
  const next = { ...(p.lists || {}) };
  for (const k of Object.keys(LISTS))
    if (lists && lists[k] !== undefined) next[k] = !!lists[k];
  const all =
    unsubscribed_all === undefined ? p.unsubscribed_all : !!unsubscribed_all;
  const { rows } = await db.query(
    `UPDATE email_preferences SET lists = $2, unsubscribed_all = $3, updated_at = NOW()
      WHERE token = $1 RETURNING *`,
    [p.token, JSON.stringify(next), all],
  );
  if (lists?.live !== undefined || unsubscribed_all !== undefined)
    await syncLiveList(p.email, !all && next.live !== false);
  return rows[0];
}

function preferencesLink(token) {
  return sitePage(`email-preferences?token=${token}`);
}
function oneClickLink(token, list) {
  const base = apiUrl();
  return base
    ? `${base}/api/email-preferences/unsubscribe?token=${token}${list ? `&list=${list}` : ""}`
    : preferencesLink(token);
}

/* ───────────────────────── send ───────────────────────── */

async function log(entry) {
  try {
    await ensureSchema();
    await db.query(
      `INSERT INTO email_send_log (template_key, email, subject, status, detail, provider, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (dedupe_key) DO UPDATE SET status = EXCLUDED.status, detail = EXCLUDED.detail,
         provider = EXCLUDED.provider, created_at = NOW()`,
      [
        entry.key,
        normEmail(entry.email),
        s(entry.subject).slice(0, 300),
        entry.status,
        s(entry.detail).slice(0, 500) || null,
        entry.provider || null,
        entry.dedupe || null,
      ],
    );
  } catch (e) {
    console.warn("[emailTemplates] log failed:", e?.message || e);
  }
}

async function alreadySent(dedupe) {
  if (!dedupe) return false;
  await ensureSchema();
  const { rows } = await db.query(
    "SELECT 1 FROM email_send_log WHERE dedupe_key = $1 AND status = 'sent' LIMIT 1",
    [dedupe],
  );
  return !!rows[0];
}

function firstName(name, email) {
  const n = s(name);
  if (n && !n.includes("@")) return n.split(/\s+/)[0];
  return "there";
}

// Send one automated email. Never throws; returns { ok, status, error? }.
//   to: address · vars: fill-ins · dedupe: send only once per key
//   unsubscribeUrl: overrides the preference-based link (live reminders)
//   throwOnError: rethrow send errors (for callers that expect it)
//   sendFn: send with this function instead of the connected account (tests)
async function sendTemplated(
  key,
  {
    to,
    vars = {},
    dedupe,
    unsubscribeUrl,
    throwOnError = false,
    preview = false,
    sendFn,
  } = {},
) {
  const email = normEmail(to);
  try {
    const tpl = await getTemplate(key);
    if (!email) return { ok: false, status: "skipped", error: "No address" };
    if (!tpl.enabled) {
      return { ok: false, status: "off" };
    }
    if (await alreadySent(dedupe)) return { ok: true, status: "duplicate" };

    let prefs = null;
    if (tpl.category === "updates" || tpl.category === "account") {
      prefs = await prefsFor(email);
      if (tpl.category === "updates" && !wants(prefs, tpl.list || "updates")) {
        await log({
          key,
          email,
          subject: tpl.subject,
          status: "skipped",
          detail: "Unsubscribed",
          dedupe: dedupe || null,
        });
        return { ok: false, status: "unsubscribed" };
      }
    }

    const [brand, settings] = await Promise.all([getBrand(), getSettings()]);
    const allVars = {
      site_name: brand.site_name,
      site_url: siteUrl(),
      site: siteUrl(),
      first_name: firstName(vars.name, email),
      email,
      ...vars,
    };
    const unsub =
      tpl.category === "updates"
        ? unsubscribeUrl || (prefs && oneClickLink(prefs.token, tpl.list))
        : "";
    const prefLink =
      prefs && tpl.category !== "office" ? preferencesLink(prefs.token) : "";
    const reason =
      tpl.category === "updates"
        ? `You’re receiving this because you signed up for ${LISTS[tpl.list || "updates"]?.label.toLowerCase() || "updates"} from ${brand.site_name}.`
        : "";
    const out = renderEmail({
      tpl,
      vars: allVars,
      brand,
      settings,
      unsubscribeUrl: unsub,
      preferencesUrl: prefLink,
      reason,
    });
    if (preview) return { ok: true, status: "preview", ...out };

    const headers = {};
    if (unsub) {
      headers["List-Unsubscribe"] = `<${unsub}>`;
      if (/\/api\/email-preferences\/unsubscribe/.test(unsub))
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    }
    try {
      const msg = {
        to: email,
        subject: out.subject,
        html: out.html,
        text: out.text,
        headers,
      };
      const r =
        (sendFn ? await sendFn(msg) : await transport.sendMail(msg)) || {};
      if (r.ok === false) throw new Error(r.error || "Send failed");
      await log({
        key,
        email,
        subject: out.subject,
        status: "sent",
        provider: r.provider,
        dedupe,
      });
      return { ok: true, status: "sent", id: r.id };
    } catch (e) {
      await log({
        key,
        email,
        subject: out.subject,
        status: "failed",
        detail: e.message,
        dedupe: null,
      });
      if (throwOnError) throw e;
      return { ok: false, status: "failed", error: e.message };
    }
  } catch (e) {
    if (throwOnError) throw e;
    console.warn(`[emailTemplates] ${key} failed:`, e?.message || e);
    return { ok: false, status: "failed", error: e?.message || String(e) };
  }
}

// Preview / test with sample fill-ins (and unsaved wording, if given).
async function previewTemplate(key, draft = {}) {
  const base = await getTemplate(key);
  const tpl = {
    ...base,
    ...pick(draft, ["subject", "heading", "body", "button"]),
  };
  const [brand, settings] = await Promise.all([getBrand(), getSettings()]);
  const vars = {
    ...SAMPLE,
    site_name: brand.site_name,
    site_url: siteUrl(),
    site: siteUrl(),
    watch_url: sitePage("live-streaming"),
    video_url: sitePage("watch/1"),
    billing_url: sitePage("account"),
    redeem_url: sitePage("account"),
    reset_url: sitePage("reset-password?token=sample"),
  };
  const sampleLink = sitePage("email-preferences");
  return renderEmail({
    tpl,
    vars,
    brand,
    settings,
    unsubscribeUrl: tpl.category === "updates" ? sampleLink : "",
    preferencesUrl: tpl.category === "office" ? "" : sampleLink,
    reason:
      tpl.category === "updates"
        ? `You’re receiving this because you signed up for ${(LISTS[tpl.list] || LISTS.updates).label.toLowerCase()} from ${brand.site_name}.`
        : "",
  });
}

function pick(o, keys) {
  const out = {};
  for (const k of keys)
    if (o && o[k] !== undefined && o[k] !== null) out[k] = String(o[k]);
  return out;
}

module.exports = {
  CATALOG,
  LISTS,
  FIELD_LABELS,
  ensureSchema,
  siteUrl,
  sitePage,
  apiUrl,
  getSettings,
  saveSettings,
  getBrand,
  getTemplate,
  listTemplates,
  saveTemplate,
  renderEmail,
  previewTemplate,
  sendTemplated,
  prefsFor,
  prefsByToken,
  updatePrefs,
  liveSignedUp,
  wants,
  preferencesLink,
  oneClickLink,
  firstName,
};
