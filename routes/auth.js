// server-api/routes/auth.js
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const db = require("../db");
const authenticate = require("../middleware/authenticate");
const router = express.Router();

const {
  sendWelcomeEmail,
  sendNewUserAlert,
  // Optional; if not defined your mailer, calls are safely wrapped.
  sendPasswordResetEmail,
} = require("../services/mailer");

/* -------------------------------------------
   DB bootstrap + helpers
------------------------------------------- */
async function ensureUsersTable() {
  // Base table (role defaults to 'user')
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Columns we rely on or support (legacy compatible)
  await db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;`
  );
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;`); // legacy support (will be phased out)
  await db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS verify_token TEXT;`
  );
  await db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT;`
  );
  await db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ;`
  );
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await db.query(
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS organization TEXT;`
  );

  // Add a (case-insensitive) unique index on email if missing
  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'users_email_lower_uniq'
      ) THEN
        CREATE UNIQUE INDEX users_email_lower_uniq ON users (LOWER(email));
      END IF;
    END$$;
  `);
}

// check if a column exists on a table (postgres)
async function hasColumn(table, column) {
  const { rows } = await db.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name=$1
        AND column_name=$2
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

function jwtFor(user) {
  const payload = { id: user.id, email: user.email, role: user.role || "user" };
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

function publicUser(u) {
  // Keep response stable (id, name, email, role)
  return { id: u.id, name: u.name, email: u.email, role: u.role || "user" };
}

function appOrigin(req) {
  return (
    process.env.APP_ORIGIN ||
    req.headers["x-forwarded-origin"] ||
    req.headers.origin ||
    `http://localhost:5001`
  );
}

/* -------------------------------------------
   Register
   POST /api/auth/register
   { name | (first_name + last_name), email, password, phone?, organization? }
------------------------------------------- */
router.post("/register", async (req, res) => {
  try {
    await ensureUsersTable();

    // Accept either single "name" or first/last for flexibility
    const nameRaw = String(req.body?.name || "").trim();
    const composed =
      (req.body?.first_name ? String(req.body.first_name).trim() : "") +
      (req.body?.last_name ? " " + String(req.body.last_name).trim() : "");
    const name = (nameRaw || composed).trim();

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    const phone =
      (req.body?.phone ? String(req.body.phone).trim() : null) || null;
    const organization =
      (req.body?.organization ? String(req.body.organization).trim() : null) ||
      null;

    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ message: "Name, email and password are required" });
    }

    // Reject duplicates early for clearer error (case-insensitive)
    const dupe = await db.query(
      `SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    if (dupe.rows[0]) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const hash = await bcrypt.hash(password, 10);
    const legacyPasswordExists = await hasColumn("users", "password");

    // Always force role to 'user' on creation
    let rows;
    if (legacyPasswordExists) {
      rows = (
        await db.query(
          `INSERT INTO users (name, email, phone, organization, password, password_hash, role, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,'user',NOW())
           RETURNING id, name, email, role, password_hash`,
          [name, email, phone, organization, hash, hash]
        )
      ).rows;
    } else {
      rows = (
        await db.query(
          `INSERT INTO users (name, email, phone, organization, password_hash, role, created_at)
           VALUES ($1,$2,$3,$4,$5,'user',NOW())
           RETURNING id, name, email, role, password_hash`,
          [name, email, phone, organization, hash]
        )
      ).rows;
    }

    const user = rows[0];

    // Fire-and-forget emails
    (async () => {
      try {
        if (sendWelcomeEmail) await sendWelcomeEmail({ to: email, name });
      } catch (e) {
        console.warn("[auth.register] welcome email failed:", e.message);
      }
      try {
        if (sendNewUserAlert) await sendNewUserAlert({ user: { name, email } });
      } catch (e) {
        console.warn("[auth.register] new user alert failed:", e.message);
      }
    })();

    const token = jwtFor(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error("POST /auth/register error:", e);
    res.status(500).json({ message: "Registration failed" });
  }
});

/* -------------------------------------------
   Login
   POST /api/auth/login
   { email, password }
------------------------------------------- */
router.post("/login", async (req, res) => {
  try {
    await ensureUsersTable();

    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    // build a safe column list depending on legacy column presence
    const legacyPasswordExists = await hasColumn("users", "password");
    const cols = ["id", "name", "email", "role", "password_hash"];
    if (legacyPasswordExists) cols.push("password");

    const { rows } = await db.query(
      `SELECT ${cols.join(",")}
         FROM users
        WHERE LOWER(email)=$1
        LIMIT 1`,
      [email]
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ message: "Invalid credentials" });

    const hash = user.password_hash || user.password || "";
    let ok = false;

    if (hash.startsWith("$2")) {
      ok = await bcrypt.compare(password, hash);
    } else {
      // legacy plain text fallback (rehash on success)
      ok = password === hash;
      if (ok && !user.password_hash) {
        const newHash = await bcrypt.hash(password, 10);
        await db.query(`UPDATE users SET password_hash=$1 WHERE id=$2`, [
          newHash,
          user.id,
        ]);
      }
    }

    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    const token = jwtFor(user);
    res.json({ token, user: publicUser(user) });
  } catch (e) {
    console.error("POST /auth/login error:", e);
    res.status(500).json({ message: "Login failed" });
  }
});

/* -------------------------------------------
   Forgot password
   POST /api/auth/forgot
   { email }
   - Generate reset token + expiry (24h)
   - Email reset link
   - Always 200 to avoid account enumeration
------------------------------------------- */
router.post("/forgot", async (req, res) => {
  try {
    await ensureUsersTable();
    const email = String(req.body?.email || "")
      .trim()
      .toLowerCase();
    if (!email) return res.status(400).json({ message: "Email is required" });

    const { rows } = await db.query(
      `SELECT id, name, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
      [email]
    );
    const user = rows[0];

    if (user) {
      const token = crypto.randomBytes(32).toString("hex");
      await db.query(
        `UPDATE users
           SET reset_token=$1,
               reset_token_expires = NOW() + INTERVAL '1 day'
         WHERE id=$2`,
        [token, user.id]
      );

      const base = appOrigin(req).replace(/\/$/, "");
      // Adjust "/reset" path to match your front-end route if needed
      const link = `${base}/reset?token=${encodeURIComponent(token)}`;

      (async () => {
        try {
          if (sendPasswordResetEmail) {
            await sendPasswordResetEmail({
              to: user.email,
              name: user.name || user.email,
              link,
            });
          }
        } catch (e) {
          console.warn("[auth.forgot] reset email failed:", e.message);
        }
      })();
    }

    // Always OK (avoid leaking user existence)
    res.json({
      ok: true,
      message: "If that email exists, we sent a reset link.",
    });
  } catch (e) {
    console.error("POST /auth/forgot error:", e);
    res.status(500).json({ message: "Failed to initiate password reset" });
  }
});

/* -------------------------------------------
   Verify reset token (optional helper for UI)
   GET /api/auth/reset/verify?token=...
------------------------------------------- */
router.get("/reset/verify", async (req, res) => {
  try {
    await ensureUsersTable();
    const token = String(req.query?.token || "").trim();
    if (!token) return res.status(400).json({ message: "Missing token" });

    const { rows } = await db.query(
      `SELECT id FROM users
        WHERE reset_token=$1
          AND (reset_token_expires IS NULL OR reset_token_expires > NOW())
        LIMIT 1`,
      [token]
    );

    if (!rows[0]) {
      return res
        .status(400)
        .json({ ok: false, message: "Invalid or expired token" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("GET /auth/reset/verify error:", e);
    res.status(500).json({ message: "Verification failed" });
  }
});

/* -------------------------------------------
   Reset password
   POST /api/auth/reset
   { token, password }
------------------------------------------- */
router.post("/reset", async (req, res) => {
  try {
    await ensureUsersTable();
    const token = String(req.body?.token || "").trim();
    const password = String(req.body?.password || "");

    if (!token || !password) {
      return res
        .status(400)
        .json({ message: "Token and new password are required" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters" });
    }

    const { rows } = await db.query(
      `SELECT id FROM users
        WHERE reset_token=$1
          AND (reset_token_expires IS NULL OR reset_token_expires > NOW())
        LIMIT 1`,
      [token]
    );
    const user = rows[0];
    if (!user)
      return res.status(400).json({ message: "Invalid or expired token" });

    const newHash = await bcrypt.hash(password, 10);
    const legacyPasswordExists = await hasColumn("users", "password");

    if (legacyPasswordExists) {
      await db.query(
        `UPDATE users
            SET password_hash=$1,
                password=$1,
                reset_token=NULL,
                reset_token_expires=NULL
          WHERE id=$2`,
        [newHash, user.id]
      );
    } else {
      await db.query(
        `UPDATE users
            SET password_hash=$1,
                reset_token=NULL,
                reset_token_expires=NULL
          WHERE id=$2`,
        [newHash, user.id]
      );
    }

    res.json({ ok: true, message: "Password updated successfully" });
  } catch (e) {
    console.error("POST /auth/reset error:", e);
    res.status(500).json({ message: "Failed to reset password" });
  }
});

/* -------------------------------------------
   Current user
   GET /api/auth/me
------------------------------------------- */
router.get("/me", authenticate, async (req, res) => {
  try {
    // req.user is populated by authenticate middleware
    const { rows } = await db.query(
      `SELECT id, name, email, role FROM users WHERE id=$1 LIMIT 1`,
      [req.user.id]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(publicUser(user));
  } catch (e) {
    console.error("GET /auth/me error:", e);
    res.status(500).json({ message: "Failed to load user" });
  }
});

module.exports = router;
