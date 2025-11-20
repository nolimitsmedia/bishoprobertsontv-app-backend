#!/usr/bin/env node
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../db");

const TARGETS = [
  { email: "growth.demo@bishoptv.test", name: "Growth Demo", role: "user" },
  {
    email: "essentials.demo@bishoptv.test",
    name: "Essentials Demo",
    role: "user",
  },
  { email: "custom.demo@bishoptv.test", name: "Custom Demo", role: "user" },
];

const PASSWORD = process.argv[2] || "Passw0rd!";

async function getCols() {
  const { rows } = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
  `);
  const set = new Set(rows.map((r) => r.column_name));
  return {
    hasId: set.has("id"),
    hasName: set.has("name"),
    hasEmail: set.has("email"),
    hasPassword: set.has("password"),
    hasPasswordHash: set.has("password_hash"),
    hasRole: set.has("role"),
    hasCreatedAt: set.has("created_at"),
    hasEmailVerified: set.has("email_verified"),
    hasIsVerified: set.has("is_verified"),
  };
}

async function ensureUser(email, name, role, cols, hash) {
  const { rows } = await db.query(
    "SELECT id FROM users WHERE lower(email)=lower($1) LIMIT 1",
    [email]
  );

  if (!rows[0]) {
    // Build INSERT with whatever columns exist
    const fields = ["email"];
    const vals = [email];

    if (cols.hasName) fields.push("name"), vals.push(name);
    if (cols.hasRole) fields.push("role"), vals.push(role);

    // Always set at least one password column
    if (cols.hasPasswordHash) fields.push("password_hash"), vals.push(hash);
    if (cols.hasPassword) fields.push("password"), vals.push(hash);

    if (cols.hasEmailVerified) fields.push("email_verified"), vals.push(true);
    if (cols.hasIsVerified) fields.push("is_verified"), vals.push(true);

    const ph = fields.map((_, i) => `$${i + 1}`).join(",");
    await db.query(
      `INSERT INTO users (${fields.join(",")}) VALUES (${ph})`,
      vals
    );
    console.log(`+ created ${email}`);
    return;
  }

  // UPDATE — always include at least one password column in SET
  const sets = [];
  const vals = [];
  let i = 1;

  if (cols.hasName) sets.push(`name=$${i++}`), vals.push(name);
  if (cols.hasRole) sets.push(`role=$${i++}`), vals.push(role);
  if (cols.hasPasswordHash) sets.push(`password_hash=$${i++}`), vals.push(hash);
  if (cols.hasPassword) sets.push(`password=$${i++}`), vals.push(hash);
  if (cols.hasEmailVerified) sets.push(`email_verified=TRUE`);
  if (cols.hasIsVerified) sets.push(`is_verified=TRUE`);

  // Safety: if somehow no columns were set, bail out with a helpful message
  if (sets.length === 0) {
    throw new Error(
      "No updatable columns found. Ensure your users table has at least one of: password_hash or password."
    );
  }

  vals.push(email);
  await db.query(
    `UPDATE users SET ${sets.join(", ")} WHERE lower(email)=lower($${i})`,
    vals
  );
  console.log(`~ updated ${email}`);
}

(async () => {
  try {
    const cols = await getCols();
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const t of TARGETS) {
      await ensureUser(t.email, t.name, t.role, cols, hash);
    }
    console.log(`\nDone. Password set to: ${PASSWORD}`);
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
