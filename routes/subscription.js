// server-api/routes/subscription.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const authenticate = require("../middleware/authenticate");

// Prefer Node 18+ fetch; fallback to node-fetch dynamically.
const fetch =
  globalThis.fetch ||
  ((...args) => import("node-fetch").then(({ default: f }) => f(...args)));

const {
  sendPurchaseReceipt,
  sendNewSubscriberAlert,
} = require("../services/mailer");

/* ───────────────────────── helpers ───────────────────────── */

function cleanInt(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

// canonical: starter | pro | custom
function canonicalPlanCode(str) {
  const s = String(str || "").toLowerCase();
  if (!s) return null;
  if (s.includes("custom") || s.includes("enterprise")) return "custom";
  if (s.includes("starter") || s.includes("basic") || s.includes("growth"))
    return "starter";
  if (s.includes("pro") || s.includes("plus") || s.includes("essential"))
    return "pro";
  if (["starter", "pro", "custom"].includes(s)) return s;
  return null;
}
function labelForCode(code) {
  if (code === "starter") return "Starter";
  if (code === "pro") return "Pro";
  if (code === "custom") return "Custom";
  return null;
}

/* ─────────────────────── DB bootstrap/migration ─────────────────────── */

async function ensureTables() {
  // Plans
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscription_plans (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      price_cents INTEGER NOT NULL DEFAULT 0,
      interval TEXT NOT NULL DEFAULT 'month',
      status TEXT NOT NULL DEFAULT 'public',
      in_trial_days INTEGER NOT NULL DEFAULT 0,
      thumbnail_url TEXT,
      storage_hours_limit INTEGER,
      live_hours_limit INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Subscriptions (legacy tables may be missing many columns)
  await db.query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      plan_id INTEGER REFERENCES subscription_plans (id) ON DELETE SET NULL,
      plan TEXT NOT NULL DEFAULT 'free',
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add any missing columns expected by the code
  await db.query(`
    ALTER TABLE subscriptions
      ADD COLUMN IF NOT EXISTS plan_code TEXT,
      ADD COLUMN IF NOT EXISTS plan_title TEXT,
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS interval TEXT,
      ADD COLUMN IF NOT EXISTS provider TEXT,
      ADD COLUMN IF NOT EXISTS provider_ref TEXT,
      ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS renews_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
  `);

  // Helpful indexes
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_active
      ON subscriptions (user_id)
      WHERE canceled_at IS NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_subscriptions_plan
      ON subscriptions (plan_id)
      WHERE canceled_at IS NULL;
  `);

  // Reasonable defaults for plan quotas (only if NULL)
  await db.query(`
    UPDATE subscription_plans
       SET live_hours_limit = COALESCE(live_hours_limit, 100),
           storage_hours_limit = COALESCE(storage_hours_limit, 100)
     WHERE LOWER(title) LIKE '%starter%';
  `);
  await db.query(`
    UPDATE subscription_plans
       SET live_hours_limit = COALESCE(live_hours_limit, 200),
           storage_hours_limit = COALESCE(storage_hours_limit, 200)
     WHERE LOWER(title) LIKE '%pro%';
  `);
  await db.query(`
    UPDATE subscription_plans
       SET live_hours_limit = COALESCE(live_hours_limit, 500),
           storage_hours_limit = COALESCE(storage_hours_limit, 500)
     WHERE LOWER(title) LIKE '%custom%' OR LOWER(title) LIKE '%enterprise%';
  `);
}

/* ───────────────────── internal helpers (exported at bottom) ───────────────────── */

function toPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || "",
    price_cents: cleanInt(row.price_cents, 0),
    interval: row.interval || "month",
    status: row.status || "public",
    in_trial_days: cleanInt(row.in_trial_days, 0),
    thumbnail_url: row.thumbnail_url || null,
    storage_hours_limit:
      row.storage_hours_limit === null
        ? null
        : cleanInt(row.storage_hours_limit, null),
    live_hours_limit:
      row.live_hours_limit === null
        ? null
        : cleanInt(row.live_hours_limit, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
    total_subscribers: cleanInt(row.total_subscribers, 0),
    content_count: cleanInt(row.content_count, 0),
  };
}

async function getMetrics() {
  await ensureTables();
  const { rows: activeRows } = await db.query(
    `SELECT COUNT(*)::int AS c FROM subscriptions s WHERE s.canceled_at IS NULL`
  );
  const { rows: mrrRows } = await db.query(
    `SELECT COALESCE(SUM(
        CASE p.interval WHEN 'month' THEN p.price_cents
                        WHEN 'year'  THEN (p.price_cents / 12.0)
                        ELSE 0 END
      )::bigint, 0) AS mrr
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.canceled_at IS NULL`
  );
  const { rows: trialRows } = await db.query(
    `SELECT COUNT(*)::int AS c
       FROM subscriptions s
       JOIN subscription_plans p ON p.id = s.plan_id
      WHERE s.canceled_at IS NULL
        AND p.in_trial_days > 0
        AND (s.started_at + (p.in_trial_days || ' days')::interval) >= NOW()`
  );
  return {
    active_subscribers: activeRows[0]?.c || 0,
    mrr_cents: cleanInt(mrrRows[0]?.mrr || 0, 0),
    in_trial: trialRows[0]?.c || 0,
  };
}

/** Determine billing window [period_start, period_end). */
function computePeriodWindow(startedAt, interval, renewsAt) {
  const end = renewsAt || null;
  const s = new Date(startedAt || Date.now());
  const i = (interval || "month").toLowerCase();
  let period_end;
  if (end) period_end = new Date(end);
  else {
    // fallback: 1 month/year from start
    period_end =
      i === "year"
        ? new Date(
            s.getFullYear() + 1,
            s.getMonth(),
            s.getDate(),
            s.getHours(),
            s.getMinutes(),
            s.getSeconds()
          )
        : new Date(
            s.getFullYear(),
            s.getMonth() + 1,
            s.getDate(),
            s.getHours(),
            s.getMinutes(),
            s.getSeconds()
          );
  }
  // period_start is one interval before end
  const period_start =
    i === "year"
      ? new Date(
          period_end.getFullYear() - 1,
          period_end.getMonth(),
          period_end.getDate(),
          period_end.getHours(),
          period_end.getMinutes(),
          period_end.getSeconds()
        )
      : new Date(
          period_end.getFullYear(),
          period_end.getMonth() - 1,
          period_end.getDate(),
          period_end.getHours(),
          period_end.getMinutes(),
          period_end.getSeconds()
        );
  return { period_start, period_end };
}

/** Get the active subscription row + normalized code/limits. */
async function deriveActiveSubscription(userId) {
  await ensureTables();
  const { rows } = await db.query(
    `
    SELECT
      s.*, p.title AS plan_title_from_plan,
      p.interval AS plan_interval,
      p.live_hours_limit AS plan_live_hours_limit
    FROM subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.user_id = $1 AND s.canceled_at IS NULL
    ORDER BY s.id DESC
    LIMIT 1
  `,
    [userId]
  );
  const row = rows[0];
  if (!row) return null;

  const code =
    row.plan_code ||
    canonicalPlanCode(row.plan_title) ||
    canonicalPlanCode(row.plan_title_from_plan) ||
    canonicalPlanCode(row.plan) ||
    null;

  const interval = row.interval || row.plan_interval || "month";

  // Limits: prefer plan row value; otherwise map by code
  const mappedLimit =
    code === "starter"
      ? 100
      : code === "pro"
      ? 200
      : code === "custom"
      ? 500
      : 0;

  const live_hours_limit =
    row.plan_live_hours_limit != null
      ? cleanInt(row.plan_live_hours_limit, mappedLimit)
      : mappedLimit;

  const { period_start, period_end } = computePeriodWindow(
    row.started_at,
    interval,
    row.renews_at || row.current_period_end || null
  );

  return {
    id: row.id,
    user_id: row.user_id,
    code: code || "free",
    title:
      row.plan_title ||
      row.plan_title_from_plan ||
      labelForCode(code) ||
      "Free",
    interval,
    live_hours_limit,
    period_start,
    period_end,
  };
}

/** Sum live usage in hours within the billing window.
 *  Fallback only: count events that actually started (no created_at fallback).
 */
async function getLiveUsageHoursBetween(userId, start, end) {
  try {
    const { rows } = await db.query(
      `
      SELECT COALESCE(
        SUM(EXTRACT(EPOCH FROM (COALESCE(ended_at, NOW()) - started_at))) / 3600.0,
        0
      ) AS hours
      FROM live_events
      WHERE created_by = $1
        AND started_at IS NOT NULL
        AND started_at >= $2
        AND started_at <  $3
      `,
      [userId, start, end]
    );
    return Number(rows[0]?.hours || 0);
  } catch {
    // If the table doesn't exist yet, treat as 0 used.
    return 0;
  }
}

/* ───────────────────────── Plans API ───────────────────────── */

router.get("/plans", async (req, res) => {
  try {
    await ensureTables();
    const limit = Math.min(1000, Math.max(1, cleanInt(req.query.limit, 100)));
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();

    const where = [];
    const params = [];
    if (q) {
      params.push(`%${q}%`, `%${q}%`);
      where.push("(LOWER(title) LIKE $1 OR LOWER(description) LIKE $2)");
    }

    const sql = `
      SELECT p.*,
             0::int AS total_subscribers,
             0::int AS content_count
        FROM subscription_plans p
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY p.updated_at DESC, p.id DESC
       LIMIT ${limit};
    `;
    const { rows } = await db.query(sql, params);
    res.json({ items: rows.map(toPlan), metrics: await getMetrics() });
  } catch (e) {
    console.error("GET /subscription/plans error:", e);
    res.status(500).json({ message: "Failed to load plans" });
  }
});

router.get("/plans/:id", async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query(
      `SELECT p.*, 0::int AS total_subscribers, 0::int AS content_count
         FROM subscription_plans p
        WHERE p.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(toPlan(rows[0]));
  } catch (e) {
    console.error("GET /subscription/plans/:id error:", e);
    res.status(500).json({ message: "Failed to load plan" });
  }
});

router.post("/plans", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const {
      title,
      description,
      price_cents,
      interval = "month",
      status = "public",
      in_trial_days = 0,
      thumbnail_url = null,
      storage_hours_limit = null,
      live_hours_limit = null,
    } = req.body || {};

    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Title is required" });
    }

    const { rows } = await db.query(
      `INSERT INTO subscription_plans
       (title, description, price_cents, interval, status, in_trial_days, thumbnail_url,
        storage_hours_limit, live_hours_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        String(title).trim(),
        description || null,
        cleanInt(price_cents, 0),
        interval === "year" ? "year" : "month",
        ["public", "private", "archived"].includes(status) ? status : "public",
        cleanInt(in_trial_days, 0),
        thumbnail_url || null,
        storage_hours_limit === null
          ? null
          : cleanInt(storage_hours_limit, null),
        live_hours_limit === null ? null : cleanInt(live_hours_limit, null),
      ]
    );

    res.json(toPlan(rows[0]));
  } catch (e) {
    console.error("POST /subscription/plans error:", e);
    res.status(500).json({ message: "Failed to create plan" });
  }
});

router.put("/plans/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const id = req.params.id;
    const fields = [];
    const params = [];
    let i = 1;

    function set(col, val) {
      fields.push(`${col} = $${i++}`);
      params.push(val);
    }

    const body = req.body || {};
    if (body.title !== undefined) set("title", String(body.title || "").trim());
    if (body.description !== undefined)
      set("description", body.description || null);
    if (body.price_cents !== undefined)
      set("price_cents", cleanInt(body.price_cents, 0));
    if (body.interval !== undefined)
      set("interval", body.interval === "year" ? "year" : "month");
    if (body.status !== undefined) {
      const s = ["public", "private", "archived"].includes(body.status)
        ? body.status
        : "public";
      set("status", s);
    }
    if (body.in_trial_days !== undefined)
      set("in_trial_days", cleanInt(body.in_trial_days, 0));
    if (body.thumbnail_url !== undefined)
      set("thumbnail_url", body.thumbnail_url || null);
    if (body.storage_hours_limit !== undefined)
      set(
        "storage_hours_limit",
        body.storage_hours_limit === null
          ? null
          : cleanInt(body.storage_hours_limit, null)
      );
    if (body.live_hours_limit !== undefined)
      set(
        "live_hours_limit",
        body.live_hours_limit === null
          ? null
          : cleanInt(body.live_hours_limit, null)
      );

    fields.push("updated_at = NOW()");
    if (!fields.length) return res.status(400).json({ message: "No changes" });

    params.push(id);
    const { rows } = await db.query(
      `UPDATE subscription_plans SET ${fields.join(
        ", "
      )} WHERE id = $${i} RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ message: "Not found" });
    res.json(toPlan(rows[0]));
  } catch (e) {
    console.error("PUT /subscription/plans/:id error:", e);
    res.status(500).json({ message: "Failed to update plan" });
  }
});

router.delete("/plans/:id", authenticate, async (req, res) => {
  try {
    await ensureTables();
    await db.query("DELETE FROM subscription_plans WHERE id=$1", [
      req.params.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    console.error("DELETE /subscription/plans/:id error:", e);
    res.status(500).json({ message: "Failed to delete plan" });
  }
});

router.post("/plans/:id/duplicate", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const { rows } = await db.query(
      "SELECT * FROM subscription_plans WHERE id=$1",
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ message: "Not found" });

    const src = rows[0];
    const ins = await db.query(
      `INSERT INTO subscription_plans
       (title, description, price_cents, interval, status, in_trial_days, thumbnail_url,
        storage_hours_limit, live_hours_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        `${src.title} (Copy)`,
        src.description,
        src.price_cents,
        src.interval,
        src.status,
        src.in_trial_days,
        src.thumbnail_url,
        src.storage_hours_limit,
        src.live_hours_limit,
      ]
    );

    res.json(toPlan(ins.rows[0]));
  } catch (e) {
    console.error("POST /subscription/plans/:id/duplicate error:", e);
    res.status(500).json({ message: "Failed to duplicate plan" });
  }
});

/* ───────────────────── quick flags (back-compat) ───────────────────── */

router.get("/", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.json({ plan: "free" });

    const sub = await deriveActiveSubscription(userId);
    res.json({ plan: sub?.code && sub.code !== "free" ? sub.code : "free" });
  } catch (e) {
    console.error("GET /subscription error:", e);
    res.status(500).json({ message: "Error checking subscription" });
  }
});

router.get("/customer", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.json({ subscribed: false });

    const { rows } = await db.query(
      `SELECT 1 FROM subscriptions WHERE user_id=$1 AND canceled_at IS NULL LIMIT 1`,
      [userId]
    );
    res.json({ subscribed: rows.length > 0 });
  } catch (e) {
    console.error("GET /subscription/customer error:", e);
    res.status(500).json({ message: "Error checking subscription" });
  }
});

/* ───────────────────── full details for dashboard (with usage) ───────────────────── */

router.get("/me", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) {
      return res.json({ plan: "free", plan_title: "Free", status: "none" });
    }

    const sub = await deriveActiveSubscription(userId);
    if (!sub) {
      return res.json({ plan: "free", plan_title: "Free", status: "none" });
    }

    // Prefer usage service; fallback to summing within the period using started_at only
    let used = 0;
    try {
      const { getMonthlyUsage } = require("../services/usage");
      const val = await getMonthlyUsage(userId, "live_hours_monthly");
      used = Number.isFinite(val) ? Number(val) : 0;
    } catch {
      used = await getLiveUsageHoursBetween(
        userId,
        sub.period_start,
        sub.period_end
      );
    }

    const remaining =
      sub.live_hours_limit > 0
        ? Math.max(0, sub.live_hours_limit - used)
        : null;

    // explicit second precision
    const usedSeconds = Math.round(used * 3600);
    const limitSeconds =
      sub.live_hours_limit > 0 ? sub.live_hours_limit * 3600 : null;

    res.json({
      id: sub.id,
      plan_id: null,
      plan: sub.code || "starter",
      plan_code: sub.code || null,
      plan_title: sub.title,
      interval: sub.interval,
      price_cents: 0,
      started_at: sub.period_start,
      renews_at: sub.period_end,
      current_period_end: sub.period_end,
      resets_at: sub.period_end,
      provider: null,
      provider_ref: null,
      status: sub.code === "free" ? "none" : "active",

      live_hours_limit: sub.live_hours_limit,
      live_hours_used: +used.toFixed(4),
      live_hours_remaining: remaining,

      // new explicit fields
      live_seconds_used: usedSeconds,
      live_seconds_limit: limitSeconds,
    });
  } catch (e) {
    console.error("GET /subscription/me error:", e);
    res.status(500).json({ message: "Failed to load subscription details" });
  }
});

/* ───────────────────── simple subscribe (test) ───────────────────── */

router.post("/subscribe", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    const planId = cleanInt(req.body?.plan_id, 0);
    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!planId)
      return res.status(400).json({ message: "plan_id is required" });

    const { rows: planRows } = await db.query(
      "SELECT * FROM subscription_plans WHERE id=$1 AND status != 'archived'",
      [planId]
    );
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    // end any existing
    await db.query(
      "UPDATE subscriptions SET canceled_at = NOW() WHERE user_id=$1 AND canceled_at IS NULL",
      [userId]
    );

    const code = canonicalPlanCode(plan.title) || "starter";
    const human = labelForCode(code);

    const { rows } = await db.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, plan, plan_code, plan_title, status, interval,
          started_at, created_at, provider, provider_ref, renews_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,
               NOW(),NOW(),$7,$8,$9,NOW())
       RETURNING *`,
      [
        userId,
        planId,
        code,
        code,
        human,
        plan.interval || "month",
        null,
        null,
        null,
      ]
    );

    res.json({ ok: true, subscription: rows[0] });
  } catch (e) {
    console.error("POST /subscription/subscribe error:", e);
    res.status(500).json({ message: "Failed to subscribe" });
  }
});

/* ───────────────────── PayPal verification / activation ───────────────────── */

async function getPayPalAccessToken() {
  const base = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;

  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`PayPal token error: ${resp.status} ${t}`);
  }
  return resp.json();
}
async function getPayPalOrder(orderId) {
  const base = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
  const { access_token } = await getPayPalAccessToken();
  const resp = await fetch(`${base}/v2/checkout/orders/${orderId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`PayPal order fetch error: ${resp.status} ${t}`);
  }
  return resp.json();
}
async function getPayPalSubscription(subId) {
  const base = process.env.PAYPAL_BASE || "https://api-m.sandbox.paypal.com";
  const { access_token } = await getPayPalAccessToken();
  const resp = await fetch(`${base}/v1/billing/subscriptions/${subId}`, {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`PayPal subscription fetch error: ${resp.status} ${t}`);
  }
  return resp.json();
}

router.post("/confirm-paypal", authenticate, async (req, res) => {
  try {
    await ensureTables();
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { paypalOrderId, paypalSubscriptionId, plan_id } = req.body || {};
    if (!plan_id || (!paypalOrderId && !paypalSubscriptionId)) {
      return res.status(400).json({
        message:
          "plan_id and (paypalOrderId or paypalSubscriptionId) are required",
      });
    }

    const { rows: planRows } = await db.query(
      "SELECT * FROM subscription_plans WHERE id=$1 AND status != 'archived'",
      [plan_id]
    );
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ message: "Plan not found" });

    let verified = false;
    let amountCents = plan.price_cents || 0;
    let interval = plan.interval || "month";
    let renews_at = null;
    let provider_ref = null;

    if (paypalOrderId) {
      const order = await getPayPalOrder(paypalOrderId);
      verified = order.status === "COMPLETED" || order.status === "APPROVED";
      provider_ref = paypalOrderId;
    } else if (paypalSubscriptionId) {
      const sub = await getPayPalSubscription(paypalSubscriptionId);
      verified = sub.status === "ACTIVE";
      provider_ref = paypalSubscriptionId;
      if (sub?.billing_info?.next_billing_time) {
        renews_at = new Date(sub.billing_info.next_billing_time);
      }
    }

    if (!verified) {
      return res
        .status(400)
        .json({ message: "PayPal payment not verified yet" });
    }

    await db.query(
      "UPDATE subscriptions SET canceled_at = NOW() WHERE user_id=$1 AND canceled_at IS NULL",
      [userId]
    );

    const code = canonicalPlanCode(plan.title) || "starter";
    const human = labelForCode(code);

    const { rows: subRows } = await db.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, plan, plan_code, plan_title, status, interval,
          started_at, created_at, provider, provider_ref, renews_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'active',$6,
               NOW(),NOW(),'paypal',$7,$8,NOW())
       RETURNING *`,
      [userId, plan.id, code, code, human, interval, provider_ref, renews_at]
    );

    // Emails (fire & forget)
    (async () => {
      try {
        const u = await db.query(
          "SELECT id, name, email FROM users WHERE id=$1",
          [userId]
        );
        const user = u.rows[0];
        await sendPurchaseReceipt({
          to: user.email,
          name: user.name || "there",
          planName: plan.title,
          amount: amountCents,
          currency: "USD",
          interval,
          invoiceUrl: null,
        });
      } catch (e) {
        console.warn("receipt email failed:", e.message);
      }
      try {
        await sendNewSubscriberAlert({
          userId,
          planName: plan.title,
          amount: amountCents,
          currency: "USD",
          interval,
        });
      } catch (e) {
        console.warn("internal alert failed:", e.message);
      }
    })();

    res.json({ ok: true, subscription: subRows[0] });
  } catch (e) {
    console.error("POST /subscription/confirm-paypal error:", e);
    res.status(500).json({ message: "Could not confirm PayPal payment" });
  }
});

module.exports = router;
/* expose helpers so other routes (e.g., live) can reuse them if needed */
module.exports._helpers = {
  deriveActiveSubscription,
  getLiveUsageHoursBetween,
  ensureTables,
  computePeriodWindow,
  canonicalPlanCode,
};
