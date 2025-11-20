#!/usr/bin/env node
require("dotenv").config();
const bcrypt = require("bcryptjs");
const db = require("../db");

/** ---- Helpers to introspect your schema ---- */
async function getUserColumns() {
  const { rows } = await db.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users'
  `);
  return rows.map((r) => r.column_name);
}

async function ensureSubscriptionsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_code TEXT NOT NULL CHECK (plan_code IN ('growth','essentials','custom')),
      cycle TEXT NOT NULL CHECK (cycle IN ('monthly','yearly')),
      provider TEXT NOT NULL,              -- 'seed'|'paypal'|'stripe'
      provider_sub_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      current_period_start TIMESTAMPTZ,
      current_period_end TIMESTAMPTZ,
      UNIQUE(user_id)
    );
  `);
}

async function findUserByEmail(email) {
  const { rows } = await db.query(
    `SELECT id FROM users WHERE email=$1 LIMIT 1`,
    [email]
  );
  return rows[0] || null;
}

/**
 * Create or update a user with a hashed password.
 * It will write the bcrypt hash to whichever columns exist:
 *  - password_hash (preferred)
 *  - hashed_password (sometimes used)
 *  - password (kept as hash too for compatibility)
 * Also sets role/name if those columns exist and flips email_verified/is_verified to true if present.
 */
async function upsertUser({ name, email, password, role = "user" }) {
  const cols = await getUserColumns();
  const hasPasswordHash = cols.includes("password_hash");
  const hasHashedPass = cols.includes("hashed_password");
  const hasPassword = cols.includes("password");
  const hasRole = cols.includes("role");
  const hasName = cols.includes("name");
  const hasEmailVer =
    cols.includes("email_verified") || cols.includes("is_verified");

  const hash = await bcrypt.hash(password, 10);

  const existing = await findUserByEmail(email);
  if (!existing) {
    const fields = ["email"];
    const vals = [email];

    if (hasName) {
      fields.push("name");
      vals.push(name);
    }
    if (hasRole) {
      fields.push("role");
      vals.push(role);
    }

    if (hasPasswordHash) {
      fields.push("password_hash");
      vals.push(hash);
    }
    if (hasHashedPass) {
      fields.push("hashed_password");
      vals.push(hash);
    }

    // If only "password" exists, we still store bcrypt hash in it
    if (hasPassword) {
      fields.push("password");
      vals.push(hash);
    }

    if (hasEmailVer) {
      const verCol = cols.includes("email_verified")
        ? "email_verified"
        : "is_verified";
      fields.push(verCol);
      vals.push(true);
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`).join(",");
    const sql = `INSERT INTO users (${fields.join(
      ","
    )}) VALUES (${placeholders}) RETURNING id`;
    const { rows } = await db.query(sql, vals);
    return rows[0].id;
  } else {
    // update password + optional fields
    const sets = [];
    const vals = [];
    let i = 1;

    if (hasName) {
      sets.push(`name=$${i++}`);
      vals.push(name);
    }
    if (hasRole) {
      sets.push(`role=$${i++}`);
      vals.push(role);
    }

    if (hasPasswordHash) {
      sets.push(`password_hash=$${i++}`);
      vals.push(hash);
    }
    if (hasHashedPass) {
      sets.push(`hashed_password=$${i++}`);
      vals.push(hash);
    }
    if (hasPassword) {
      sets.push(`password=$${i++}`);
      vals.push(hash);
    }

    if (hasEmailVer) {
      const verCol = cols.includes("email_verified")
        ? "email_verified"
        : "is_verified";
      sets.push(`${verCol}=TRUE`);
    }

    if (sets.length) {
      vals.push(email);
      await db.query(
        `UPDATE users SET ${sets.join(", ")} WHERE email=$${i}`,
        vals
      );
    }
    return existing.id;
  }
}

async function upsertSubscription(userId, { plan_code, cycle }) {
  const sql = `
    INSERT INTO subscriptions (user_id, plan_code, cycle, provider, status, started_at)
    VALUES ($1,$2,$3,'seed','active',NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET plan_code=EXCLUDED.plan_code,
          cycle=EXCLUDED.cycle,
          provider='seed',
          status='active'
    RETURNING id
  `;
  const { rows } = await db.query(sql, [userId, plan_code, cycle]);
  return rows[0].id;
}

(async () => {
  try {
    await ensureSubscriptionsTable();

    const PASSWORD = "Passw0rd!";
    const demos = [
      {
        label: "Growth",
        name: "Growth Demo",
        email: "growth.demo@bishoptv.test",
        plan_code: "growth",
        cycle: "monthly",
      },
      {
        label: "Essentials",
        name: "Essentials Demo",
        email: "essentials.demo@bishoptv.test",
        plan_code: "essentials",
        cycle: "monthly",
      },
      {
        label: "Custom",
        name: "Custom Demo",
        email: "custom.demo@bishoptv.test",
        plan_code: "custom",
        cycle: "yearly",
      },
    ];

    for (const d of demos) {
      const userId = await upsertUser({
        name: d.name,
        email: d.email,
        password: PASSWORD,
        role: "user",
      });
      await upsertSubscription(userId, {
        plan_code: d.plan_code,
        cycle: d.cycle,
      });
      console.log(
        `✓ ${d.label} -> ${d.email} / ${PASSWORD} (plan=${d.plan_code}, cycle=${d.cycle})`
      );
    }

    console.log("\nDone. Use those credentials to log in via /login.");
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
