// server-api/services/subscriptions.js
const db = require("../db");

// Recommended once in DB (for "one active row per user"):
// ALTER TABLE subscriptions ADD CONSTRAINT uniq_sub_user UNIQUE (user_id);

function toTs(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isFinite(+d) ? d : null;
}

/**
 * Upsert a subscription for a user.
 * `patch` can include:
 *   status, plan_code, started_at, current_period_end, renews_at,
 *   canceled_at, provider, provider_ref, portal_url
 *
 * - status is stored lowercased if present
 * - started_at defaults to NOW() when first created
 */
async function upsertSubscription(userId, patch = {}) {
  const {
    status = null,
    plan_code = null,
    started_at = null,
    current_period_end = null,
    renews_at = null,
    canceled_at = null,
    provider = null,
    provider_ref = null,
    portal_url = null,
  } = patch;

  const normalizedStatus =
    typeof status === "string" ? status.toLowerCase() : status;

  const q = `
    INSERT INTO subscriptions
      (user_id, status, plan_code, started_at,
       current_period_end, renews_at, canceled_at,
       provider, provider_ref, portal_url, created_at)
    VALUES
      ($1,$2,$3,COALESCE($4,NOW()),$5,$6,$7,$8,$9,$10,NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      status              = COALESCE(EXCLUDED.status, subscriptions.status),
      plan_code           = COALESCE(EXCLUDED.plan_code, subscriptions.plan_code),
      started_at          = COALESCE(EXCLUDED.started_at, subscriptions.started_at),
      current_period_end  = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
      renews_at           = COALESCE(EXCLUDED.renews_at, subscriptions.renews_at),
      canceled_at         = COALESCE(EXCLUDED.canceled_at, subscriptions.canceled_at),
      provider            = COALESCE(EXCLUDED.provider, subscriptions.provider),
      provider_ref        = COALESCE(EXCLUDED.provider_ref, subscriptions.provider_ref),
      portal_url          = COALESCE(EXCLUDED.portal_url, subscriptions.portal_url),
      created_at          = subscriptions.created_at
    RETURNING *;
  `;

  const params = [
    userId,
    normalizedStatus,
    plan_code,
    toTs(started_at),
    toTs(current_period_end),
    toTs(renews_at),
    toTs(canceled_at),
    provider,
    provider_ref,
    portal_url,
  ];

  const { rows } = await db.query(q, params);
  return rows[0];
}

/**
 * Fetch the *most recent* subscription for a user and
 * return it only if it is currently active (strict rules):
 *  - status in ('active','trial','trialing')
 *  - not canceled (canceled_at absent or in the future)
 *  - current_period_end (or renews_at) in the future
 */
async function getActiveForUser(userId) {
  const { rows } = await db.query(
    `
    SELECT
      id, user_id, status, plan_code, started_at, created_at,
      COALESCE(canceled_at, cancelled_at) AS canceled_at,
      current_period_end, renews_at, provider, provider_ref, portal_url
    FROM subscriptions
    WHERE user_id = $1
    ORDER BY created_at DESC NULLS LAST
    LIMIT 1
    `,
    [userId]
  );

  const s = rows[0];
  if (!s) return null;

  const now = new Date();

  const status = String(s.status || "").toLowerCase();
  const allowed =
    status === "active" || status === "trial" || status === "trialing";

  const canceledAt = s.canceled_at ? new Date(s.canceled_at) : null;
  const isCanceled =
    canceledAt && Number.isFinite(+canceledAt) && canceledAt <= now;

  const endCandidate = s.current_period_end || s.renews_at || null;
  const periodEnd = endCandidate ? new Date(endCandidate) : null;
  const notExpired =
    periodEnd && Number.isFinite(+periodEnd) && periodEnd > now;

  if (allowed && !isCanceled && notExpired) {
    return s;
  }
  return null;
}

/**
 * Mark a user's subscription as canceled now (status + canceled_at).
 */
async function markCanceled(userId) {
  const { rows } = await db.query(
    `
    UPDATE subscriptions
       SET status = 'canceled',
           canceled_at = COALESCE(canceled_at, NOW())
     WHERE user_id = $1
     RETURNING *;
    `,
    [userId]
  );
  return rows[0];
}

module.exports = { upsertSubscription, getActiveForUser, markCanceled };
