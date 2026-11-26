#!/usr/bin/env node
// server-api/scripts/check-env.js
//
// Phase 2D: checks this server's settings and says, in plain words, what is
// missing or unsafe. Run on the server (Render › Shell) or locally:
//   node scripts/check-env.js
try {
  require("dotenv").config();
} catch {
  /* use the environment as is */
}
const e = process.env;
const rows = [];
const add = (level, key, msg) => rows.push([level, key, msg]);
const has = (k) => String(e[k] || "").trim() !== "";
const https = (k) => /^https:\/\/[^\s]+$/.test(String(e[k] || ""));

// Required
if (!has("DATABASE_URL")) add("✗", "DATABASE_URL", "missing — the server can't reach its database");
if (!has("JWT_SECRET")) add("✗", "JWT_SECRET", "missing — sign-ins can't work (production refuses to start)");
else if (e.JWT_SECRET.length < 32) add("!", "JWT_SECRET", "short — use at least 32 random characters");
else if (/dev|secret|change|test|brtv/i.test(e.JWT_SECRET) && e.JWT_SECRET.length < 40)
  add("!", "JWT_SECRET", "looks like a placeholder — use a random value");
if (!has("APP_ENCRYPTION_KEY")) add("✗", "APP_ENCRYPTION_KEY", "missing — email and live-stream passwords can't be saved");
else if (Buffer.from(e.APP_ENCRYPTION_KEY, "base64").length !== 32)
  add("✗", "APP_ENCRYPTION_KEY", "must be 32 bytes in base64 (node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\")");
if (!has("SITE_NAME")) add("!", "SITE_NAME", "missing — emails and defaults say \"Our Ministry\" until a name is saved in Site Settings");
if (!https("PUBLIC_SITE_URL")) add("✗", "PUBLIC_SITE_URL", "missing or not https — links in emails (password reset, unsubscribe) won't point to the site");
if (!https("PUBLIC_BASE_URL")) add("✗", "PUBLIC_BASE_URL", "missing or not https — one-click unsubscribe links won't work");
if (!has("CLIENT_ORIGIN")) add("!", "CLIENT_ORIGIN", "missing — the website may be blocked from calling the API (CORS)");
else if (has("PUBLIC_SITE_URL") && https("PUBLIC_SITE_URL")) {
  const origin = new URL(e.PUBLIC_SITE_URL).origin;
  const list = e.CLIENT_ORIGIN.split(",").map((s) => s.trim());
  if (!list.includes(origin)) add("✗", "CLIENT_ORIGIN", `must include ${origin} (the site's address)`);
}
if (!has("CALENDAR_TIMEZONE")) add("!", "CALENDAR_TIMEZONE", "missing — Eastern Time is used");
else {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: e.CALENDAR_TIMEZONE });
  } catch {
    add("✗", "CALENDAR_TIMEZONE", "not a valid time zone name (e.g. America/Chicago)");
  }
}
// Services (warnings only: some ministries connect these in the admin instead)
for (const [k, msg] of [
  ["BUNNY_STREAM_API_KEY", "video uploads/playback need the ministry's Bunny Stream library (or set it in Admin › Integration › Cloud Storage)"],
]) if (!has(k)) add("!", k, msg);
if (e.MAILGUN_API_KEY && !e.MAILGUN_DOMAIN) add("!", "MAILGUN_DOMAIN", "Mailgun key set without a domain");

if (!rows.length) {
  console.log("✓ All settings look good.");
  process.exit(0);
}
const bad = rows.filter((r) => r[0] === "✗").length;
for (const [lvl, k, msg] of rows) console.log(`${lvl} ${k.padEnd(20)} ${msg}`);
console.log(`\n${bad} problem(s), ${rows.length - bad} warning(s).  ✗ = must fix   ! = check`);
process.exit(bad ? 1 : 0);
