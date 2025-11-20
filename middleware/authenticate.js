// server-api/middleware/authenticate.js
const jwt = require("jsonwebtoken");

module.exports = function authenticate(req, res, next) {
  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";

    // Accept: Authorization: Bearer <token>, x-access-token header, or cookie "token"
    const h = req.headers.authorization || req.get("x-access-token") || "";
    const cookieToken = req.cookies?.token;
    const raw = h.startsWith("Bearer ") ? h.slice(7) : h || cookieToken;

    if (!raw) {
      return res.status(401).json({ message: "Auth required (no token)" });
    }

    const payload = jwt.verify(raw, secret);
    req.user = {
      id: payload.id,
      email: payload.email,
      role: payload.role || "user",
    };
    next();
  } catch (e) {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
};
