// server-api/services/usage.js
const db = require("../db");

function monthWindow(date = new Date()) {
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
  );
  const end = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ); // last day
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

/** Increment a periodized counter and log event. */
async function addUsage(
  userId,
  metric,
  amount,
  meta = null,
  period = "monthly"
) {
  if (!Number.isFinite(amount) || amount <= 0) return;

  let period_start, period_end;
  if (metric === "live_hours_monthly" || period === "monthly") {
    const win = monthWindow();
    period_start = win.start;
    period_end = win.end;
  } else {
    // storage_hours = non-periodized (treat as a single window far in the future)
    period_start = "2000-01-01";
    period_end = "2999-12-31";
  }

  await db.query(
    `INSERT INTO usage_counters (user_id, metric, period_start, period_end, amount)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id,metric,period_start,period_end)
     DO UPDATE SET amount = usage_counters.amount + EXCLUDED.amount`,
    [userId, metric, period_start, period_end, amount]
  );

  await db.query(
    `INSERT INTO usage_events (user_id, metric, amount, meta)
     VALUES ($1,$2,$3,$4)`,
    [userId, metric, amount, meta ? JSON.stringify(meta) : null]
  );
}

async function getUsage(userId) {
  const { rows } = await db.query(
    `SELECT metric, SUM(amount) AS amount
     FROM usage_counters
     WHERE user_id=$1
     GROUP BY metric`,
    [userId]
  );
  const out = {};
  for (const r of rows) out[r.metric] = Number(r.amount);
  return out;
}

/** Get the current month’s usage for a monthly metric */
async function getMonthlyUsage(userId, metric) {
  const { start, end } = monthWindow();
  const { rows } = await db.query(
    `SELECT amount FROM usage_counters
     WHERE user_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
    [userId, metric, start, end]
  );
  return rows[0] ? Number(rows[0].amount) : 0;
}

module.exports = { addUsage, getUsage, getMonthlyUsage };
