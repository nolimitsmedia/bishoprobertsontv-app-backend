// server-api/middleware/entitlements.js
const db = require("../db");

/** Fallback limits if plan doesn't specify them */
const DEFAULT_STORAGE_HOURS = Number(
  process.env.STORAGE_HOURS_LIMIT_DEFAULT || 100
);
const DEFAULT_LIVE_HOURS = Number(process.env.LIVE_HOURS_LIMIT_DEFAULT || 100);

/* ------------------------------ time utils -------------------------------- */
function startOfMonthUTC(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function addMonthsUTC(d, m) {
  const dt = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds()
    )
  );
  dt.setUTCMonth(dt.getUTCMonth() + m);
  return dt;
}
function addYearsUTC(d, y) {
  const dt = new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours(),
      d.getUTCMinutes(),
      d.getUTCSeconds(),
      d.getUTCMilliseconds()
    )
  );
  dt.setUTCFullYear(dt.getUTCFullYear() + y);
  return dt;
}

/* --------------------------- attachEntitlements ---------------------------- */
/**
 * Loads the user's plan limits + current billing window into req.entitlements:
 * {
 *   limits: { storage_hours_total: number|null, live_hours_monthly: number|null },
 *   period: { start: Date, end: Date },
 *   label: string,
 *   features?: { [key]: boolean }
 * }
 */
async function attachEntitlements(req, _res, next) {
  try {
    // Anonymous: give defaults (mostly irrelevant since protected routes require auth)
    if (!req.user?.id) {
      req.entitlements = {
        limits: {
          storage_hours_total: DEFAULT_STORAGE_HOURS,
          live_hours_monthly: DEFAULT_LIVE_HOURS,
        },
        period: {
          start: startOfMonthUTC(),
          end: addMonthsUTC(startOfMonthUTC(), 1),
        },
        label: "anonymous",
        features: {},
      };
      return next();
    }

    const uid = req.user.id;

    // Active subscription + plan
    const { rows } = await db.query(
      `SELECT s.renews_at, s.started_at, COALESCE(s.interval, p.interval, 'month') AS interval,
              p.title,
              p.storage_hours_limit,  -- INTEGER or NULL = unlimited
              p.live_hours_limit      -- INTEGER or NULL = unlimited
         FROM subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
        WHERE s.user_id = $1
          AND s.canceled_at IS NULL
        ORDER BY s.id DESC
        LIMIT 1`,
      [uid]
    );

    // Defaults (Free)
    let limits = {
      storage_hours_total: DEFAULT_STORAGE_HOURS,
      live_hours_monthly: DEFAULT_LIVE_HOURS,
    };
    let label = "Free";
    let periodStart = startOfMonthUTC();
    let periodEnd = addMonthsUTC(periodStart, 1);

    if (rows[0]) {
      const r = rows[0];
      label = r.title || "Subscription";

      // Limits from plan (NULL = unlimited)
      const storageLimit =
        r.storage_hours_limit == null ? null : Number(r.storage_hours_limit);
      const liveLimit =
        r.live_hours_limit == null ? null : Number(r.live_hours_limit);

      limits = {
        storage_hours_total:
          storageLimit == null ? null : Math.max(0, storageLimit),
        live_hours_monthly: liveLimit == null ? null : Math.max(0, liveLimit),
      };

      // Period: prefer renews_at; fall back to calendar months/years
      const interval = String(r.interval || "month").toLowerCase();
      if (r.renews_at) {
        const renewsAt = new Date(r.renews_at);
        if (interval === "year") {
          periodEnd = renewsAt;
          periodStart = addYearsUTC(renewsAt, -1);
        } else {
          // default monthly
          periodEnd = renewsAt;
          periodStart = addMonthsUTC(renewsAt, -1);
        }
      } else {
        // calendar month fallback
        periodStart = startOfMonthUTC();
        periodEnd = addMonthsUTC(periodStart, 1);
      }
    }

    req.entitlements = {
      limits,
      period: { start: periodStart, end: periodEnd },
      label,
      features: {}, // hook for future feature flags
    };

    next();
  } catch (e) {
    console.warn("[entitlements] attach failed:", e.message);
    // Fail open with safe defaults
    req.entitlements = {
      limits: {
        storage_hours_total: DEFAULT_STORAGE_HOURS,
        live_hours_monthly: DEFAULT_LIVE_HOURS,
      },
      period: {
        start: startOfMonthUTC(),
        end: addMonthsUTC(startOfMonthUTC(), 1),
      },
      label: "unknown",
      features: {},
    };
    next();
  }
}

/* ----------------------------- requireFeature ------------------------------ */
function requireFeature(featureKey) {
  return (req, res, next) => {
    const ok = !!req.entitlements?.features?.[featureKey];
    if (!ok) {
      return res
        .status(403)
        .json({ error: "Feature not available on your plan." });
    }
    next();
  };
}

/* -------------------------------- checkQuota ------------------------------- */
/**
 * Period-aware quota check.
 *
 * @param {'storage_hours_total'|'live_hours_monthly'} metric
 * @param {(req) => number} getIncrement   // how much we plan to add right now (e.g., video duration hours)
 *
 * Notes:
 *  - We *do not* record usage here. Your route should call services/usage.addUsage(...)
 *    after the operation (e.g., after upload completes, or when live ends).
 *  - We sum usage inside the current entitlements period (start..end).
 */
function checkQuota(metric, getIncrement) {
  return async (req, res, next) => {
    try {
      const uid = req.user?.id;
      if (!uid) return res.status(401).json({ message: "Unauthorized" });

      const limits = req.entitlements?.limits || {};
      const limit = limits[metric];

      // Unlimited or not configured => allow
      if (limit == null) return next();

      const inc =
        typeof getIncrement === "function" ? Number(getIncrement(req) || 0) : 0;

      const start = req.entitlements?.period?.start || startOfMonthUTC();
      const end =
        req.entitlements?.period?.end || addMonthsUTC(startOfMonthUTC(), 1);

      // Sum usage in period
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(amount),0) AS used
           FROM usage_events
          WHERE user_id = $1
            AND metric  = $2
            AND created_at >= $3
            AND created_at <  $4`,
        [uid, metric, start, end]
      );
      const used = Number(rows[0]?.used || 0);

      if (used + inc > Number(limit) + 1e-9) {
        return res.status(403).json({
          message: "Quota exceeded",
          metric,
          used,
          increment: inc,
          limit: Number(limit),
          period: { start, end },
        });
      }

      next();
    } catch (e) {
      console.warn("[entitlements] checkQuota error:", e.message);
      // fail open to avoid false negatives caused by outages
      next();
    }
  };
}

module.exports = { attachEntitlements, requireFeature, checkQuota };
