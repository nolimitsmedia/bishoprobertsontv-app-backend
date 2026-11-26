#!/usr/bin/env node
// server-api/scripts/profile-env.js
//
// Phase 2D: the server settings (Render › Environment) for one ministry, from
// its client profile — so the website and the server always agree.
//
//   node scripts/profile-env.js ../admin-panel/client-profile/profile.json
//   node scripts/profile-env.js <profile.json> --new     (a NEW server: also
//        prints fresh JWT_SECRET and APP_ENCRYPTION_KEY values)
//
// Paste the output into Render › Environment. Add the ministry's own
// DATABASE_URL, Bunny, Mailgun/payment keys separately.
const fs = require("fs");
const crypto = require("crypto");

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("Usage: node scripts/profile-env.js <path to profile.json> [--new]");
  process.exit(1);
}
const P = JSON.parse(fs.readFileSync(file, "utf8"));
const site = String(P.site_url || "").replace(/\/+$/, "");
const api = String(P.api_url || "").replace(/\/+$/, "");
if (!/^https:\/\//.test(site) || !/^https:\/\//.test(api)) {
  console.error("profile.json needs https site_url and api_url (check: npm run profile:check)");
  process.exit(1);
}
const origins = new Set([new URL(site).origin, ...(P.extra_origins || [])]);

const lines = [
  `# ${P.site_name} — generated from client-profile/profile.json`,
  `SITE_NAME=${P.site_name}`,
  `PUBLIC_SITE_URL=${site}`,
  `PUBLIC_BASE_URL=${api}`,
  `CLIENT_ORIGIN=${[...origins].join(",")}`,
  `CALENDAR_TIMEZONE=${P.timezone}`,
];
if (P.community_channels) lines.push(`COMMUNITY_CHANNELS=${P.community_channels}`);
if (process.argv.includes("--new")) {
  lines.push(
    "# New server only — generated once; never change them afterwards:",
    `JWT_SECRET=${crypto.randomBytes(48).toString("hex")}`,
    `APP_ENCRYPTION_KEY=${crypto.randomBytes(32).toString("base64")}`,
  );
}
console.log(lines.join("\n"));
