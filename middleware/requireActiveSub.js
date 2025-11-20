// server-api/middleware/requireActiveSub.js
const db = require("../db");

module.exports = async function requireActiveSub(req, res, next) {
  try {
    const uid = req?.user?.id;
    if (!uid) return res.status(401).json({ message: "Unauthorized" });

    const { rows } = await db.query(
      `
      SELECT
        id, user_id, status, plan_code, started_at,
        current_period_end, renews_at, canceled_at
      FROM subscriptions
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [uid]
    );

    const sub = rows[0];
    if (!sub) {
      return res.status(402).json({
        message: "Active subscription required",
        code: "NO_SUBSCRIPTION",
      });
    }

    const now = new Date();
    const canceled = sub.canceled_at ? new Date(sub.canceled_at) <= now : false;
    const periodEnd = sub.current_period_end
      ? new Date(sub.current_period_end)
      : sub.renews_at
      ? new Date(sub.renews_at)
      : null;
    const notExpired = periodEnd ? periodEnd > now : true;

    const status = String(sub.status || "").toLowerCase();
    const okStatus =
      status === "active" || status === "trialing" || status === "trial";
    const ok = okStatus && !canceled && notExpired;

    if (!ok) {
      return res.status(402).json({
        message: "Active subscription required",
        code: "SUB_INACTIVE",
        details: {
          status: sub.status,
          plan_code: sub.plan_code,
          canceled_at: sub.canceled_at,
          current_period_end: sub.current_period_end,
          renews_at: sub.renews_at,
        },
      });
    }

    req.subscription = sub;
    next();
  } catch (err) {
    console.error("[requireActiveSub] error:", err);
    return res.status(402).json({
      message: "Active subscription required",
      code: "SUB_CHECK_FAILED",
    });
  }
};
