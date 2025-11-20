// server-api/services/entitlements.js
const db = require("../db");
const { PLAN_DEFS, ADD_ON_DEFS } = require("../billing/entitlements");

/**
 * Resolve the current plan of a user.
 *  - You may want to scope subscriptions by org/account instead of user_id.
 */
async function getActiveSubscription(userId) {
  const q = `
    SELECT * FROM subscriptions
    WHERE user_id = $1 AND status = 'active'
    ORDER BY started_at DESC
    LIMIT 1
  `;
  const { rows } = await db.query(q, [userId]);
  return rows[0] || null;
}

/** Fetch add-ons for the user and aggregate totals */
async function getAddOnTotals(userId) {
  const q = `SELECT sku, SUM(quantity) AS qty FROM subscription_addons WHERE user_id=$1 GROUP BY sku`;
  const { rows } = await db.query(q, [userId]);
  const totals = { storage_hours: 0, live_hours_monthly: 0 };
  for (const r of rows) {
    const sku = r.sku;
    const qty = Number(r.qty || 0);
    const def = ADD_ON_DEFS[sku];
    if (!def || !qty) continue;
    if (def.storage_hours) totals.storage_hours += def.storage_hours * qty;
    if (def.live_hours_monthly)
      totals.live_hours_monthly += def.live_hours_monthly * qty;
  }
  return totals;
}

/**
 * Public API — returns normalized entitlements for a user.
 */
async function getEntitlements(userId) {
  const subs = await getActiveSubscription(userId);
  const planCode = subs?.plan_code || "growth"; // default to Growth for safety
  const plan = PLAN_DEFS[planCode] || PLAN_DEFS.growth;

  // base quotas
  const quotas = { ...plan.quotas };

  // add-ons
  const addOns = await getAddOnTotals(userId);
  for (const k of Object.keys(addOns)) {
    if (quotas[k] == null) continue; // custom/unlimited stays unlimited
    quotas[k] += addOns[k];
  }

  return {
    plan_code: planCode,
    label: plan.label,
    features: { ...plan.features },
    quotas,
    support: plan.support,
  };
}

module.exports = { getEntitlements };
