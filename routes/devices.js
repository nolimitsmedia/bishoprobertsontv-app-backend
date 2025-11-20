const express = require("express");
const router = express.Router();
const db = require("../db");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

let requireAuth;
try {
  ({ requireAuth } = require("../middleware/auth"));
} catch {}
let authenticate;
try {
  authenticate = require("../middleware/authenticate");
} catch {}
const baseAuth =
  (typeof requireAuth === "function" && requireAuth) ||
  authenticate ||
  ((_req, _res, next) => next());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

/* bootstrap */
async function ensureDeviceTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS device_links (
      id SERIAL PRIMARY KEY,
      device_code TEXT UNIQUE NOT NULL,
      user_code   TEXT UNIQUE NOT NULL,
      user_id     INTEGER,
      status      TEXT NOT NULL DEFAULT 'pending', -- pending|linked|expired
      device_type TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMPTZ NOT NULL
    );
  `);
  await db.query(
    `CREATE INDEX IF NOT EXISTS idx_device_links_codes ON device_links (device_code, user_code);`
  );
}
function randBase32(n = 20) {
  return crypto.randomBytes(n).toString("base64url");
}
function humanCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++)
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

/**
 * POST /devices/pair  body: { device_type? }
 * -> { device_code, user_code, expires_at, poll_interval }
 */
router.post("/pair", async (req, res) => {
  try {
    await ensureDeviceTable();
    const device_code = randBase32(18);
    const user_code = humanCode(6);
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.query(
      `INSERT INTO device_links (device_code, user_code, device_type, expires_at)
       VALUES ($1,$2,$3,$4)`,
      [device_code, user_code, req.body?.device_type || null, expires]
    );

    res.json({
      device_code,
      user_code,
      expires_at: expires.toISOString(),
      poll_interval: 5, // seconds
    });
  } catch (e) {
    console.error("POST /devices/pair error:", e);
    res.status(500).json({ message: "Failed to create pairing" });
  }
});

/**
 * POST /devices/activate  (web, authenticated)
 * body: { user_code }
 */
router.post("/activate", baseAuth, async (req, res) => {
  try {
    await ensureDeviceTable();
    const code = String(req.body?.user_code || "")
      .trim()
      .toUpperCase();
    if (!code) return res.status(400).json({ message: "user_code required" });

    const q = await db.query(
      `SELECT * FROM device_links
        WHERE user_code=$1 AND status='pending' AND expires_at > NOW()
        LIMIT 1`,
      [code]
    );
    const row = q.rows[0];
    if (!row)
      return res.status(404).json({ message: "Code not found or expired" });

    const userId =
      req?.user?.id || req?.user?.user_id || req?.user?.uid || null;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    await db.query(
      `UPDATE device_links
          SET status='linked', user_id=$1
        WHERE id=$2`,
      [userId, row.id]
    );

    res.json({ ok: true });
  } catch (e) {
    console.error("POST /devices/activate error:", e);
    res.status(500).json({ message: "Failed to activate device" });
  }
});

/**
 * GET /devices/poll?device_code=...
 * -> pending: { status:'pending' }
 * -> linked:  { status:'linked', token, user:{id,email?,name?} }
 */
router.get("/poll", async (req, res) => {
  try {
    await ensureDeviceTable();
    const code = String(req.query.device_code || "");
    if (!code) return res.status(400).json({ message: "device_code required" });

    const q = await db.query(
      `SELECT dl.*, u.name, u.email
         FROM device_links dl
    LEFT JOIN users u ON u.id = dl.user_id
        WHERE dl.device_code=$1
        LIMIT 1`,
      [code]
    );
    const row = q.rows[0];
    if (!row) return res.status(404).json({ message: "Not found" });
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return res.json({ status: "expired" });
    }
    if (row.status !== "linked" || !row.user_id) {
      return res.json({ status: "pending" });
    }
    // issue normal JWT used by your API
    const token = jwt.sign({ id: row.user_id }, JWT_SECRET, {
      expiresIn: "30d",
    });
    // (optionally) expire the link after success:
    await db.query(`UPDATE device_links SET status='expired' WHERE id=$1`, [
      row.id,
    ]);

    res.json({
      status: "linked",
      token,
      user: { id: row.user_id, name: row.name, email: row.email },
    });
  } catch (e) {
    console.error("GET /devices/poll error:", e);
    res.status(500).json({ message: "Polling failed" });
  }
});

module.exports = router;
