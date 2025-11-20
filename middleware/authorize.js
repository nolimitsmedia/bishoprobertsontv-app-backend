// middleware/authorize.js
const db = require("../db");

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ message: "Admin only" });
}

// Use when a feature should only work for paying users
async function requireActiveSubscriber(req, res, next) {
  if (!req.user) return res.status(401).json({ message: "Unauthorized" });
  const { rows } = await db.query(
    `SELECT 1 FROM subscriptions
      WHERE user_id=$1 AND canceled_at IS NULL
      LIMIT 1`,
    [req.user.id]
  );
  if (!rows[0])
    return res.status(402).json({ message: "Subscription required" });
  next();
}

module.exports = { requireAuth, requireAdmin, requireActiveSubscriber };
