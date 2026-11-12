#!/usr/bin/env node
// server-api/scripts/setup-customer.js
//
// Release 1.3 (white-label): set up the database for a NEW customer in one
// command. Uses DATABASE_URL from the environment (.env).
//
//   node scripts/setup-customer.js --site-name "Grace Church TV" \
//        --owner-name "Pastor Ann" --owner-email ann@gracechurch.org
//   (the Owner password is read from SETUP_OWNER_PASSWORD, or asked for)
//
// Steps: base schema (if the database is empty) › every migration once
// (recorded in schema_migrations) › the Owner account › the brand name.
// Safety: refuses a database that already has pages, unless --force.

try {
  require("dotenv").config(); // server-api/.env
} catch {
  // dotenv not installed: use the environment as is
}
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const db = require("../db");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? String(process.argv[i + 1] || "") : "";
}
const has = (name) => process.argv.includes(`--${name}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
async function ask(question, hidden) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  if (hidden) rl._writeToOutput = () => {};
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(a);
    }),
  );
}
async function tableExists(name) {
  const { rows } = await db.query(`SELECT to_regclass($1) AS t`, [
    `public.${name}`,
  ]);
  return !!rows[0].t;
}

(async () => {
  const siteName = arg("site-name");
  const ownerName = arg("owner-name");
  const ownerEmail = arg("owner-email").toLowerCase();
  if (
    !siteName ||
    !ownerName ||
    !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(ownerEmail)
  )
    fail(
      'Usage: node scripts/setup-customer.js --site-name "Name" --owner-name "Name" --owner-email you@example.org',
    );
  if (!process.env.DATABASE_URL)
    fail("DATABASE_URL is not set (add it to server-api/.env).");

  // 1) Base schema for an empty database
  if (!(await tableExists("users"))) {
    const base = path.join(__dirname, "..", "db", "base_schema.sql");
    if (!fs.existsSync(base))
      fail(
        "This database is empty and db/base_schema.sql is missing. See WHITE_LABEL_GUIDE.md › Base schema.",
      );
    console.log("• Creating the base schema…");
    await db.query(fs.readFileSync(base, "utf8"));
  } else if (!has("force")) {
    if (await tableExists("pages")) {
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM pages");
      if (rows[0].n > 0)
        fail(
          "This database already has pages. Is it the right database? Re-run with --force to continue anyway.",
        );
    }
  }

  // 2) Migrations, each once
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  );
  const dir = path.join(__dirname, "..", "db", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const { rows: done } = await db.query(
    "SELECT filename FROM schema_migrations",
  );
  const applied = new Set(done.map((r) => r.filename));
  for (const f of files) {
    if (applied.has(f)) continue;
    console.log(`• Migration ${f}`);
    await db.query(fs.readFileSync(path.join(dir, f), "utf8"));
    await db.query(
      "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
      [f],
    );
  }

  // 3) Owner account
  let password = process.env.SETUP_OWNER_PASSWORD || "";
  if (!password)
    password = await ask("Owner password (at least 10 characters): ", true);
  if (password.length < 10)
    fail("The Owner password must have at least 10 characters.");
  const bcrypt = require("bcrypt");
  const hash = await bcrypt.hash(password, 10);
  const { rows: cols } = await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND table_schema = ANY (current_schemas(false))`,
  );
  const colSet = new Set(cols.map((c) => c.column_name));
  const { rows: existing } = await db.query(
    "SELECT id FROM users WHERE lower(email) = $1",
    [ownerEmail],
  );
  let ownerId;
  if (existing.length) {
    ownerId = existing[0].id;
    await db.query(
      `UPDATE users SET name = $2, role = 'admin', password_hash = $3${colSet.has("password") ? ", password = $3" : ""} WHERE id = $1`,
      [ownerId, ownerName, hash],
    );
    console.log("• Existing account promoted to administrator");
  } else {
    const fields = ["name", "email", "password_hash", "role"];
    const values = [ownerName, ownerEmail, hash, "admin"];
    if (colSet.has("password")) {
      fields.push("password");
      values.push(hash);
    }
    const { rows } = await db.query(
      `INSERT INTO users (${fields.join(", ")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
      values,
    );
    ownerId = rows[0].id;
    console.log("• Owner account created");
  }
  if (colSet.has("is_owner")) {
    await db.query(
      "UPDATE users SET is_owner = (id = $1) WHERE is_owner IS TRUE OR id = $1",
      [ownerId],
    );
  }

  // 4) Brand name (Site Settings › Brand)
  if (await tableExists("site_design_settings")) {
    const { rows } = await db.query(
      "SELECT published_json FROM site_design_settings WHERE setting_key = 'site_options'",
    );
    const opts = { ...(rows[0]?.published_json || {}) };
    opts.brand = { ...(opts.brand || {}), name: siteName.slice(0, 80) };
    await db.query(
      `INSERT INTO site_design_settings (setting_key, draft_json, published_json, published_at)
       VALUES ('site_options', $1::jsonb, $1::jsonb, NOW())
       ON CONFLICT (setting_key) DO UPDATE SET draft_json = EXCLUDED.draft_json,
         published_json = EXCLUDED.published_json, published_at = NOW(), updated_at = NOW()`,
      [JSON.stringify(opts)],
    );
    console.log(`• Brand name set to "${siteName}"`);
  }

  console.log(
    `\n✓ Done. Sign in as ${ownerEmail}, then finish the brand in Content › Site Settings.`,
  );
  console.log(
    "  Frontend: set REACT_APP_SITE_NAME, REACT_APP_SITE_URL, REACT_APP_LIVE_CHANNEL_ID",
  );
  console.log(
    "  (and REACT_APP_ROUTER=browser for clean addresses) — see WHITE_LABEL_GUIDE.md.\n",
  );
  await db.pool?.end?.();
  process.exit(0);
})().catch((e) => fail(e?.message || String(e)));
