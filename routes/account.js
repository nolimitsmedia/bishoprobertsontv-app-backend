// server-api/routes/accounts.js
const express = require("express");
const router = express.Router();
const db = require("../db");

let jwt;
try {
  jwt = require("jsonwebtoken");
} catch (_) {}

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

/* ---------------- Auth helper ---------------- */
function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const p = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: p.id ?? p.userId ?? p.sub,
      email: p.email,
      name: p.name,
      role: p.role || "user",
    };
    if (req.user.id == null)
      return res.status(401).json({ error: "Unauthorized" });
    next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

/* ------------- Plan name inference ------------- */
function inferPlanName(codeOrId) {
  if (!codeOrId) return null;
  const s = String(codeOrId).toLowerCase();
  if (s.includes("growth")) return "Growth plan";
  if (s.includes("essential")) return "App Essentials plan";
  if (s.includes("custom") || s.includes("enterprise"))
    return "Custom-made plan";
  return null;
}

/* ------------- Read active/trialing subscription ------------- */
async function getActiveSubscription(userId) {
  try {
    const q = await db.query(
      `SELECT id, user_id, plan_id, plan_code, status,
              current_period_end, renews_at, portal_url
         FROM subscriptions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId]
    );

    const sub = q.rows[0];
    if (!sub) return null;

    let planName = null;
    let planCode = sub.plan_code || sub.plan_id || null;

    // Try to resolve via plans table (optional)
    try {
      if (sub.plan_id) {
        const p = await db.query(
          `SELECT id, code, slug, name, title
             FROM subscription_plans
            WHERE id = $1`,
          [sub.plan_id]
        );
        const row = p.rows[0];
        if (row) {
          planCode = row.code || row.slug || row.id || planCode;
          planName = row.title || row.name || row.slug || row.code || null;
        }
      }
    } catch (_) {}

    if (!planName) planName = inferPlanName(planCode);

    return {
      id: sub.id,
      status: sub.status || "active",
      plan: {
        id: sub.plan_id || planCode || null,
        code: planCode || null,
        name: planName || null,
      },
      current_period_end: sub.current_period_end || sub.renews_at || null,
      renews_at: sub.renews_at || sub.current_period_end || null,
      portal_url: sub.portal_url || null,
    };
  } catch {
    return null; // keep UI resilient
  }
}

/* ---------------- Existing endpoints (unchanged) ---------------- */

// Your original identity endpoint (kept intact)
router.get("/auth/me", requireAuth, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, name, email, role, plan_code
         FROM users
        WHERE id = $1`,
      [req.user.id]
    );
    const row = q.rows[0] || {};
    const sub = await getActiveSubscription(req.user.id);
    return res.json({
      id: row.id ?? req.user.id,
      name: row.name ?? req.user.name,
      email: row.email ?? req.user.email,
      role: row.role ?? req.user.role ?? "user",
      plan_code: row.plan_code ?? sub?.plan?.code ?? null,
    });
  } catch {
    // Fall back to the token payload if query fails
    return res.json(req.user);
  }
});

// Subscription objects for account page (unchanged)
router.get("/subscription/me", requireAuth, async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  return res.json(sub || null);
});

router.get("/subscription/portal", requireAuth, async (req, res) => {
  const sub = await getActiveSubscription(req.user.id);
  return res.json({ portal_url: sub?.portal_url || null });
});

/* ---------------- Convenience: /me mirror ----------------
   Some clients call /account/me; others use /auth/me.
   This gives you both, returning EXACTLY the same shape as /auth/me.
---------------------------------------------------------- */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const q = await db.query(
      `SELECT id, name, email, role, plan_code
         FROM users
        WHERE id = $1`,
      [req.user.id]
    );
    const row = q.rows[0] || {};
    const sub = await getActiveSubscription(req.user.id);
    return res.json({
      id: row.id ?? req.user.id,
      name: row.name ?? req.user.name,
      email: row.email ?? req.user.email,
      role: row.role ?? req.user.role ?? "user",
      plan_code: row.plan_code ?? sub?.plan?.code ?? null,
    });
  } catch {
    return res.json(req.user);
  }
});

/* ---------------- Push token management ----------------
   Table (INTEGER users.id); run once:

   CREATE TABLE IF NOT EXISTS user_push_tokens (
     id SERIAL PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     token TEXT UNIQUE NOT NULL,
     platform TEXT,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   );

   CREATE OR REPLACE FUNCTION set_updated_at()
   RETURNS TRIGGER AS $$
   BEGIN
     NEW.updated_at = NOW();
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql;

   DROP TRIGGER IF EXISTS trg_upt_updated ON user_push_tokens;
   CREATE TRIGGER trg_upt_updated
   BEFORE UPDATE ON user_push_tokens
   FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
---------------------------------------------------------*/

// Register or update the current user's device token
router.post("/push-token", requireAuth, async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ ok: false, message: "token is required" });
  }
  try {
    const sql = `
      INSERT INTO user_push_tokens (user_id, token, platform)
      VALUES ($1, $2, $3)
      ON CONFLICT (token)
      DO UPDATE SET user_id = EXCLUDED.user_id,
                    platform = EXCLUDED.platform,
                    updated_at = NOW()
      RETURNING id, user_id, token, platform, created_at, updated_at
    `;
    const { rows } = await db.query(sql, [
      req.user.id,
      token,
      platform || null,
    ]);
    res.json({ ok: true, item: rows[0] });
  } catch (e) {
    console.error("[POST /accounts/push-token] error:", e);
    res.status(500).json({ ok: false, message: "Failed to save token" });
  }
});

// Unregister a device token (e.g., on logout)
router.delete("/push-token", requireAuth, async (req, res) => {
  const { token } = req.body || {};
  if (!token || typeof token !== "string") {
    return res.status(400).json({ ok: false, message: "token is required" });
  }
  try {
    await db.query(
      `DELETE FROM user_push_tokens WHERE token = $1 AND user_id = $2`,
      [token, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /accounts/push-token] error:", e);
    res.status(500).json({ ok: false, message: "Failed to delete token" });
  }
});

// (Optional) list my tokens (good for debugging)
router.get("/push-token", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, token, platform, created_at, updated_at
         FROM user_push_tokens
        WHERE user_id = $1
        ORDER BY updated_at DESC, created_at DESC
        LIMIT 50`,
      [req.user.id]
    );
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error("[GET /accounts/push-token] error:", e);
    res.status(500).json({ ok: false, message: "Failed to list tokens" });
  }
});

module.exports = router;
