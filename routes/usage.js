// server-api/routes/usage.js
const express = require("express");
const router = express.Router();
const db = require("../db");

/* ---------------------------------------
   Optional auth (robust fallback)
--------------------------------------- */
let requireAuth;
try {
  ({ requireAuth } = require("../middleware/auth"));
} catch (_) {}
if (typeof requireAuth !== "function") {
  const jwt = require("jsonwebtoken");
  requireAuth = (req, res, next) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      // role/type may come from the token; do NOT query DB columns that might not exist
      req.user = {
        id: p.id || p.sub || p.userId,
        email: p.email,
        role: p.role,
        type: p.type,
        ...p,
      };
      if (!req.user.id) return res.status(401).json({ error: "Unauthorized" });
      next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}

/* ---------------------------------------
   Ensure schema (idempotent)
--------------------------------------- */
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER NOT NULL,
        metric        TEXT    NOT NULL, -- e.g. 'storage_hours_total', 'live_hours_monthly'
        amount        NUMERIC NOT NULL,
        meta          JSONB,
        created_at    TIMESTAMPTZ DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS usage_events_user_metric_month_idx
        ON usage_events (user_id, metric, created_at DESC);
    `);
  } catch (e) {
    console.warn("[usage] ensure table failed:", e.message || e);
  }
})();

/* ---------------------------------------
   Helpers
--------------------------------------- */
const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);

const PLAN_QUOTAS = {
  free: { storage_hours: 0, live_hours_monthly: 0 },
  growth: { storage_hours: 100, live_hours_monthly: 1 },
  essentials: { storage_hours: 100, live_hours_monthly: 1 },
  custom: { storage_hours: null, live_hours_monthly: null }, // unlimited/negotiated
};

function periodThisMonthUTC() {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0)
  );
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0)
  );
  return { start, end, resetAt: end.toISOString() };
}
function startOfNextMonthUTC() {
  return periodThisMonthUTC().end;
}

/** Only read columns that reliably exist. Fall back if plan_code is missing. */
async function getUserRow(userId) {
  try {
    const q = await db.query(
      "SELECT id, email, name, plan_code FROM users WHERE id=$1",
      [userId]
    );
    if (q.rowCount) return q.rows[0];
  } catch (e) {
    // If plan_code doesn't exist in this schema, retry without it
    if (String(e?.code) === "42703") {
      const q2 = await db.query(
        "SELECT id, email, name FROM users WHERE id=$1",
        [userId]
      );
      if (q2.rowCount) return { ...q2.rows[0], plan_code: null };
    }
    throw e;
  }
  return null;
}

async function getActiveSubscription(userId) {
  const q = await db.query(
    `SELECT id, plan_code, status, current_period_end
       FROM subscriptions
      WHERE user_id=$1
      ORDER BY id DESC
      LIMIT 1`,
    [userId]
  );
  const row = q.rows[0];
  if (!row) return null;
  return {
    plan_code: row.plan_code || null,
    status: row.status || "inactive",
    current_period_end: row.current_period_end || null,
    is_active: row.status && ACTIVE_STATUSES.has(row.status),
  };
}

async function sumMetricForCurrentMonth(userId, metric) {
  const q = await db.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS v
       FROM usage_events
      WHERE user_id=$1
        AND metric=$2
        AND created_at >= date_trunc('month', now())`,
    [userId, metric]
  );
  return Number(q.rows[0]?.v || 0);
}

function isAdminish(u) {
  const r = (u?.role || u?.type || "").toLowerCase();
  return r === "admin" || r === "owner";
}

/** Sum durations from videos for this user; admins can fall back to ALL videos if user has none */
async function storageFromVideosHoursAndCount(user, perUserOnly = false) {
  let q = await db.query(
    `SELECT COALESCE(SUM(duration_seconds),0)::bigint AS seconds,
            COUNT(*)::int AS videos
       FROM videos
      WHERE created_by = $1`,
    [user.id]
  );
  let seconds = Number(q.rows[0]?.seconds || 0);
  let videos = Number(q.rows[0]?.videos || 0);

  // Admin fallback (sum all videos) only if per-user is zero and not forced perUserOnly
  if (!perUserOnly && seconds === 0 && isAdminish(user)) {
    q = await db.query(
      `SELECT COALESCE(SUM(duration_seconds),0)::bigint AS seconds,
              COUNT(*)::int AS videos
         FROM videos`
    );
    seconds = Number(q.rows[0]?.seconds || 0);
    videos = Number(q.rows[0]?.videos || 0);
  }
  return { hours: seconds / 3600.0, videos };
}

/** Optional: if you store sizes in GB on the videos table */
async function storageFromVideosGb(user, perUserOnly = false) {
  try {
    let q = await db.query(
      `SELECT COALESCE(SUM(size_gb),0)::numeric AS gb
         FROM videos
        WHERE created_by = $1`,
      [user.id]
    );
    let gb = Number(q.rows[0]?.gb || 0);

    if (!perUserOnly && gb === 0 && isAdminish(user)) {
      q = await db.query(
        `SELECT COALESCE(SUM(size_gb),0)::numeric AS gb FROM videos`
      );
      gb = Number(q.rows[0]?.gb || 0);
    }
    return { gb };
  } catch {
    return { gb: null };
  }
}

/* ---------------------------------------
   GET /api/usage/me
--------------------------------------- */
router.get("/me", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    const [user, sub] = await Promise.all([
      getUserRow(userId),
      getActiveSubscription(userId),
    ]);
    if (!user) return res.status(404).json({ error: "User not found" });

    // choose plan: active sub first, then user's plan_code, else 'free'
    const planCode =
      (sub?.is_active && sub.plan_code) || user.plan_code || "free";
    const quotas = PLAN_QUOTAS[planCode] || PLAN_QUOTAS.free;

    // live-hours this month from usage_events
    const liveUsed = await sumMetricForCurrentMonth(
      userId,
      "live_hours_monthly"
    );

    // storage hours (preferred: sum durations from videos)
    const period = periodThisMonthUTC();
    let { hours: storageHoursUsedTotal, videos: videosCount } =
      await storageFromVideosHoursAndCount(req.user);

    // Fallback: usage_events if durations are missing
    if (!storageHoursUsedTotal || isNaN(storageHoursUsedTotal)) {
      const usedTotal = await sumMetricForCurrentMonth(
        userId,
        "storage_hours_total"
      );
      const usedLegacy = await sumMetricForCurrentMonth(
        userId,
        "storage_hours"
      ); // legacy name
      storageHoursUsedTotal = Number(usedTotal || usedLegacy || 0);

      if (videosCount == null) {
        try {
          const q = await db.query(
            `SELECT COUNT(*)::int AS videos FROM videos WHERE created_by=$1`,
            [userId]
          );
          videosCount = Number(q.rows[0]?.videos || 0);
        } catch {
          videosCount = 0;
        }
      }
    }

    // Optional GB calc
    const { gb: storageGb } = await storageFromVideosGb(req.user);

    // limits
    const liveLimit =
      quotas.live_hours_monthly != null
        ? Number(quotas.live_hours_monthly)
        : null;
    const storeLimitH =
      quotas.storage_hours != null ? Number(quotas.storage_hours) : null;

    const payload = {
      metrics: {
        live_hours_monthly: {
          used: Number(Number(liveUsed || 0).toFixed(3)),
          limit: liveLimit,
          resets: period.resetAt,
          periodStart: period.start.toISOString(),
          periodEnd: period.end.toISOString(),
        },
        storage_hours_total: {
          used: Number(Number(storageHoursUsedTotal || 0).toFixed(3)),
          limit: storeLimitH,
        },
      },
      limits: {
        live_hours_monthly: liveLimit,
        storage_hours_total: storeLimitH,
      },
      counts: {
        videos: videosCount ?? 0,
      },
      period: {
        start: period.start.toISOString(),
        end: period.end.toISOString(),
        resetAt: period.resetAt,
      },

      // legacy/convenience fields
      plan: {
        code: planCode,
        title:
          planCode === "growth"
            ? "Growth"
            : planCode === "essentials"
            ? "App Essentials"
            : planCode === "custom"
            ? "Custom"
            : "Free",
        status: sub?.status || "inactive",
        current_period_end: sub?.current_period_end || null,
      },
      usage: {
        storage_hours: Number(Number(storageHoursUsedTotal || 0).toFixed(3)),
        live_hours_monthly: Number(Number(liveUsed || 0).toFixed(3)),
      },
      quotas,
      resets_on: startOfNextMonthUTC().toISOString(),
    };

    if (storageGb != null) {
      payload.metrics.storage_gb = {
        used: Number(Number(storageGb).toFixed(3)),
        limit: null,
      };
      payload.limits.storage_gb = null;
    }

    return res.json(payload);
  } catch (e) {
    console.error("[usage] /me error:", e);
    res.status(500).json({ error: "Failed to load usage" });
  }
});

module.exports = router;
