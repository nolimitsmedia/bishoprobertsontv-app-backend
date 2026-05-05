// server-api/middleware/authenticate.js
const jwt = require("jsonwebtoken");

module.exports = function authenticate(req, res, next) {
  try {
    if (req.user?.id) {
      return next();
    }

    const secret = process.env.JWT_SECRET || "dev_secret_change_me";

    const authHeader = req.headers.authorization || "";
    const accessToken = req.get("x-access-token") || "";
    const cookieToken = req.cookies?.token || "";

    const raw = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : (accessToken || cookieToken || "").trim();

    if (!raw) {
      return res.status(401).json({ message: "Auth required (no token)" });
    }

    const payload = jwt.verify(raw, secret);

    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role || "user",
    };

    return next();
  } catch (e) {
    console.error("[authenticate] JWT failed:", e.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
