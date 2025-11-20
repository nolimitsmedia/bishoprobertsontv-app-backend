// server-api/middleware/permissions.js
const db = require("../db");

// quick helper: does user have an active subscription now?
async function hasActiveSub(userId) {
  const q = await db.query(
    `SELECT 1
       FROM subscriptions
      WHERE user_id = $1
        AND status = 'active'
        AND (current_period_end IS NULL OR current_period_end > now())
      LIMIT 1`,
    [userId]
  );
  return q.rowCount > 0;
}

// attach req.user if your JWT hasn't already done it (safety)
function requireAuth(req, res, next) {
  if (req.user?.id) return next();
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    const jwt = require("jsonwebtoken");
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: payload.id || payload.userId || payload.sub,
      email: payload.email,
      role: payload.role || "user",
    };
    if (!req.user.id) return res.status(401).json({ error: "Unauthorized" });
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// “Creator” := admin OR active subscriber
async function requireCreator(req, res, next) {
  try {
    if (!req.user?.id)
      return requireAuth(req, res, () => requireCreator(req, res, next));
    if ((req.user.role || "").toLowerCase() === "admin") return next();
    if (await hasActiveSub(req.user.id)) return next();
    return res.status(403).json({ error: "Requires an active subscription" });
  } catch (e) {
    console.error("requireCreator error", e);
    return res.status(500).json({ error: "Permission check failed" });
  }
}

// just “active subscriber”
async function requireActiveSubscriber(req, res, next) {
  try {
    if (!req.user?.id)
      return requireAuth(req, res, () =>
        requireActiveSubscriber(req, res, next)
      );
    if (await hasActiveSub(req.user.id)) return next();
    return res.status(403).json({ error: "Requires an active subscription" });
  } catch (e) {
    console.error("requireActiveSubscriber error", e);
    return res.status(500).json({ error: "Permission check failed" });
  }
}

module.exports = {
  requireAuth,
  requireCreator,
  requireActiveSubscriber,
  hasActiveSub,
};
