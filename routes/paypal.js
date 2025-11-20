// server-api/routes/paypal.js
const express = require("express");
const axios = require("axios");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const router = express.Router();

const db = require("../db");
const {
  upsertSubscription,
  markCanceled,
} = require("../services/subscriptions");
// const requireAuth = require("../middleware/authenticate"); // not used here

/* =========================
   PayPal configuration
========================= */
const PAYPAL_BASE =
  process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || "";
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || "";

/* Optional: reuse a single product across all plans.
   If missing, we’ll create it once and store in DB. */
const ENV_PRODUCT_ID = process.env.PAYPAL_PRODUCT_ID || null;

/* =========================
   Helpers
========================= */

async function paypalToken() {
  const tokenRes = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    new URLSearchParams({ grant_type: "client_credentials" }),
    {
      auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_CLIENT_SECRET },
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }
  );
  return tokenRes.data.access_token;
}

async function getPlanByCode(planCode) {
  const { rows } = await db.query(
    `SELECT id, code, title, price_cents, currency, interval, trial_days, paypal_plan_id
       FROM subscription_plans
      WHERE lower(code) = lower($1)
      LIMIT 1`,
    [planCode]
  );
  return rows[0] || null;
}

async function savePaypalPlanId(planId, paypalPlanId) {
  await db.query(
    `UPDATE subscription_plans
        SET paypal_plan_id = $2, updated_at = NOW()
      WHERE id = $1`,
    [planId, paypalPlanId]
  );
}

/* site_settings helpers (optional, safe no-op if table not present) */
async function getSetting(key) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM site_settings WHERE key = $1 LIMIT 1`,
      [key]
    );
    return rows[0]?.value || null;
  } catch {
    return null;
  }
}
async function setSetting(key, value) {
  try {
    await db.query(
      `INSERT INTO site_settings (key, value)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  } catch {}
}

/* Ensure we have a PayPal product ID we can attach plans to */
async function ensurePaypalProductId(accessToken) {
  if (ENV_PRODUCT_ID) return ENV_PRODUCT_ID;

  const cached = await getSetting("paypal_product_id");
  if (cached) return cached;

  const productName = process.env.APP_NAME || "BishopTV";
  const { data: created } = await axios.post(
    `${PAYPAL_BASE}/v1/catalogs/products`,
    {
      name: productName,
      type: "SERVICE",
      category: "SOFTWARE",
      description: `${productName} subscription product`,
    },
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!created?.id) throw new Error("Could not create PayPal product.");
  await setSetting("paypal_product_id", created.id);
  return created.id;
}

function toPaypalIntervalUnit(interval) {
  const s = String(interval || "").toLowerCase();
  if (s.startsWith("year")) return "YEAR";
  return "MONTH";
}

/* Create a PayPal plan from one DB row (name/price/interval/trial) */
async function createPaypalPlanFromDb(accessToken, planRow, productId) {
  const unit = toPaypalIntervalUnit(planRow.interval || "month");
  const price = ((planRow.price_cents || 0) / 100).toFixed(2);
  const currency = (planRow.currency || "USD").toUpperCase();
  const trialDays = Number(planRow.trial_days || 0);

  const billing_cycles = [];

  if (trialDays > 0) {
    billing_cycles.push({
      frequency: { interval_unit: "DAY", interval_count: trialDays },
      tenure_type: "TRIAL",
      sequence: 1,
      total_cycles: 1,
      pricing_scheme: {
        fixed_price: { value: "0.00", currency_code: currency },
      },
    });
  }

  billing_cycles.push({
    frequency: { interval_unit: unit, interval_count: 1 },
    tenure_type: "REGULAR",
    sequence: trialDays > 0 ? 2 : 1,
    total_cycles: 0, // 0 = infinite
    pricing_scheme: {
      fixed_price: { value: price, currency_code: currency },
    },
  });

  const payload = {
    product_id: productId,
    name: `${planRow.title} (${planRow.interval || "month"})`,
    description: `${planRow.title} subscription`,
    status: "ACTIVE",
    billing_cycles,
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: "CONTINUE",
      payment_failure_threshold: 2,
    },
    taxes: { percentage: "0", inclusive: false },
  };

  const { data: plan } = await axios.post(
    `${PAYPAL_BASE}/v1/billing/plans`,
    payload,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  if (!plan?.id) throw new Error("Creating PayPal plan failed.");
  return plan.id;
}

/* Create/FIND a user and return token (used AFTER payment is ACTIVE) */
async function ensureUserAndToken({ name, email, password }) {
  if (!email || !password || !name) {
    throw new Error("Missing signup fields (name, email, password).");
  }

  const { rows: existing } = await db.query(
    "SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1",
    [email]
  );
  let user = existing[0] || null;

  if (!user) {
    const hash = await bcrypt.hash(String(password), 10);
    const { rows } = await db.query(
      `INSERT INTO users (name, email, password_hash, role, created_at)
       VALUES ($1,$2,$3,'user',NOW()) RETURNING *`,
      [name, email, hash]
    );
    user = rows[0];
  }

  const token = jwt.sign(
    { id: user.id },
    process.env.JWT_SECRET || "changeme_dev_only",
    { expiresIn: "30d" }
  );

  return { user, token };
}

/* =========================
   Routes
========================= */

/**
 * POST /api/paypal/plan-id
 * Body: { plan_code: 'starter' | 'pro' | 'custom' }
 * Returns: { plan_id: 'P-XXXX' }
 *
 * Creates a PayPal plan lazily from your DB record, caches its ID in DB,
 * and returns it. The frontend then uses this with actions.subscription.create.
 */
router.post("/paypal/plan-id", async (req, res) => {
  try {
    const { plan_code } = req.body || {};
    if (!plan_code) {
      return res.status(400).json({ message: "plan_code is required" });
    }

    const row = await getPlanByCode(plan_code);
    if (!row) return res.status(404).json({ message: "Plan not found" });

    if (row.paypal_plan_id) {
      return res.json({ plan_id: row.paypal_plan_id });
    }

    const token = await paypalToken();
    const productId = await ensurePaypalProductId(token);
    const planId = await createPaypalPlanFromDb(token, row, productId);

    await savePaypalPlanId(row.id, planId);
    return res.json({ plan_id: planId });
  } catch (err) {
    console.error("[/paypal/plan-id] error:", err?.response?.data || err);
    return res
      .status(500)
      .json({ message: "Failed to create/fetch PayPal plan_id" });
  }
});

/**
 * POST /api/paypal/subscribe/success
 * Body: { subscription_id, plan_code, signup?: {name,email,password} }
 *
 * Called from the client ONLY after PayPal's onApprove fires.
 * We verify the subscription on PayPal and **only create the user**
 * if the subscription is actually ACTIVE.
 */
router.post("/paypal/subscribe/success", async (req, res) => {
  try {
    const { subscription_id, plan_code, signup } = req.body || {};
    if (!subscription_id) {
      return res.status(400).json({ message: "subscription_id required" });
    }

    // 1) Verify on PayPal
    const tok = await paypalToken();
    const { data: sub } = await axios.get(
      `${PAYPAL_BASE}/v1/billing/subscriptions/${subscription_id}`,
      { headers: { Authorization: `Bearer ${tok}` } }
    );

    const statusRaw = String(sub?.status || "").toLowerCase(); // active, approval_pending, etc.
    const isActive = statusRaw === "active";
    const start = sub?.start_time || new Date().toISOString();
    const nextBill = sub?.billing_info?.next_billing_time || null;

    // If not ACTIVE, do not create user. Treat as cancel/incomplete.
    if (!isActive) {
      return res.status(402).json({
        message:
          "Payment not completed. Your PayPal subscription is not ACTIVE.",
        paypal_status: sub?.status || null,
      });
    }

    // 2) Resolve user (AFTER verifying ACTIVE)
    let userId = req?.user?.id || null;
    let token = null;

    if (!userId) {
      if (!signup) {
        return res.status(401).json({
          message:
            "Not authenticated. Provide a signup payload or login before subscribing.",
        });
      }
      const created = await ensureUserAndToken(signup);
      userId = created.user.id;
      token = created.token;
    }

    // 3) Store subscription
    const row = await upsertSubscription(userId, {
      status: "active",
      plan_code: plan_code || null,
      started_at: start,
      current_period_end: nextBill,
      renews_at: nextBill,
      canceled_at: null,
      provider: "paypal",
      provider_ref: subscription_id,
    });

    return res.json({ ok: true, subscription: row, token });
  } catch (err) {
    console.error(
      "[/paypal/subscribe/success] error:",
      err?.response?.data || err
    );
    return res
      .status(500)
      .json({ message: "Failed to record PayPal subscription" });
  }
});

/**
 * POST /api/webhooks/paypal
 * Raw body required (place this route before JSON body parser or use express.raw here)
 */
router.post(
  "/webhooks/paypal",
  express.raw({ type: "*/*" }),
  async (req, res) => {
    try {
      const event = JSON.parse(req.body?.toString() || "{}");
      const resource = event.resource || {};
      const subId = resource.id || resource.subscription_id;
      if (!subId) return res.status(200).send("ok");

      const tok = await paypalToken();
      const { data: sub } = await axios.get(
        `${PAYPAL_BASE}/v1/billing/subscriptions/${subId}`,
        { headers: { Authorization: `Bearer ${tok}` } }
      );

      const statusRaw = String(sub?.status || "").toLowerCase();
      const start = sub?.start_time || null;
      const nextBill = sub?.billing_info?.next_billing_time || null;

      // Find owner
      const { rows } = await db.query(
        "SELECT user_id FROM subscriptions WHERE provider='paypal' AND provider_ref=$1 LIMIT 1",
        [subId]
      );
      const userId = rows[0]?.user_id;
      if (!userId) return res.status(200).send("ok");

      if (statusRaw === "cancelled" || statusRaw === "canceled") {
        await markCanceled(userId);
      } else {
        await upsertSubscription(userId, {
          status: statusRaw === "active" ? "active" : statusRaw,
          started_at: start,
          current_period_end: nextBill,
          renews_at: nextBill,
          provider: "paypal",
          provider_ref: subId,
        });
      }

      return res.status(200).send("ok");
    } catch (err) {
      console.error("[/webhooks/paypal] error:", err?.response?.data || err);
      // Respond 200 to avoid webhook retries storm in Sandbox
      return res.status(200).send("ok");
    }
  }
);

module.exports = router;
