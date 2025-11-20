// server-api/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const db = require("./db");

const { sendPushNotification } = require("./notifications/firebase");

// Routers (require only; don't mount until after app = express())
const authRoutes = require("./routes/auth");
const videosRoutes = require("./routes/videos");
const categoriesRoutes = require("./routes/categories");
const subscriptionRoutes = require("./routes/subscription");
const collectionsRoutes = require("./routes/collections");
const liveRoutes = require("./routes/live");
const streamcontrolRoutes = require("./routes/streamcontrol");
const siteRoutes = require("./routes/site");
const pricingRoutes = require("./routes/pricing");
const checkoutRoutes = require("./routes/checkout");
const demoRoutes = require("./routes/demo");
const usageRoutes = require("./routes/usage");
const uploadsRouter = require("./routes/upload");
const accountRoutes = require("./routes/account");
const resourcesRoutes = require("./routes/resources");
const analyticsRoutes = require("./routes/analytics");
const publicRoutes = require("./routes/public");
const devicesRoutes = require("./routes/devices");
const devEmailRoutes = require("./routes/dev-email");
const emailsRoutes = require("./routes/emails");
const channelsRouter = require("./routes/channels");
const playlistsRoutes = require("./routes/playlists");
const authBridge = require("./middleware/auth-bridge");
// Bunny
const bunnyStreamRouter = require("./routes/bunnyStream");

// NEW: Community router
const communityRoutes = require("./routes/community");

const {
  stripeWebhookHandler,
  paypalWebhookHandler,
} = require("./routes/webhooks");

// Create app BEFORE any app.use(...)
const app = express();

/* ----------------------------
   HTTP server + Socket.IO
----------------------------- */
const server = http.createServer(app);

// Build allowed origins list from multiple envs
const baseOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5001")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const extraOrigins = [
  process.env.PUBLIC_URL,
  process.env.PUBLIC_BASE_URL,
  process.env.API_BASE,
  process.env.REACT_APP_API_BASE,
]
  .filter(Boolean)
  .map((s) => s.trim());

const configuredOrigins = Array.from(
  new Set([...baseOrigins, ...extraOrigins])
);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / curl etc.
  if (configuredOrigins.includes(origin)) return true;
  if (/^https?:\/\/localhost(?::\d+)?$/.test(origin)) return true;
  return false;
}

const io = new Server(server, {
  cors: {
    origin: (origin, cb) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("Not allowed")),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },
});

// Make Socket.IO available inside routers via req.app.get("io")
app.set("io", io);

// Helpful boot log for debugging CORS issues
console.log(
  `[server] CORS allowed origins: ${
    configuredOrigins.length
      ? configuredOrigins.join(", ")
      : "(default localhost)"
  }`
);

/* ----------------------------
   Trust proxy (ngrok / proxies)
----------------------------- */
app.set("trust proxy", 1);

/* ----------------------------
   CORS (before routes)
----------------------------- */
app.use(
  cors({
    origin: (origin, cb) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("Not allowed")),
    credentials: true,
  })
);

/* ----------------------------
   Stripe webhook MUST use raw body,
   and be registered BEFORE express.json()
----------------------------- */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    req.rawBody = req.body; // Stripe needs exact raw bytes
    return stripeWebhookHandler(req, res);
  }
);

/* ----------------------------
   JSON body parser for the rest
----------------------------- */
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(authBridge);

/* ----------------------------
   Static uploads (local mode)
   Add light caching for thumbs/posters/HLS
----------------------------- */
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "public, max-age=600, stale-while-revalidate=600"
      );
    },
  })
);

/* ----------------------------
   PayPal webhook (JSON ok)
----------------------------- */
app.post("/api/webhooks/paypal", paypalWebhookHandler);

/* ----------------------------
   Routers
----------------------------- */
app.use("/api/auth", authRoutes);

// Videos (includes public catalog + public read under /api/videos/public/*)
app.use("/api/videos", videosRoutes);

app.use("/api/categories", categoriesRoutes);

// Uploads (plural) + legacy
app.use("/api/uploads", uploadsRouter);
app.use("/api/upload", uploadsRouter);

app.use("/api/subscription", subscriptionRoutes);
app.use("/api/collections", collectionsRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/live", streamcontrolRoutes);
app.use("/api/streamcontrol", streamcontrolRoutes);
app.use("/api/site", siteRoutes);

// Pricing + Checkout
app.use("/api", pricingRoutes);
app.use("/api", checkoutRoutes);
app.use("/api/demo", demoRoutes);

app.use("/api/usage", usageRoutes);
app.use("/api", accountRoutes);

app.use("/api/resources", resourcesRoutes);
app.use("/api/analytics", analyticsRoutes);
app.use("/api/public", publicRoutes);
app.use("/api", require("./routes/paypal"));

// Mobile & TV Apps
app.use("/api/devices", devicesRoutes); // ✅ mount once

// Email
app.use("/dev", devEmailRoutes);
app.use("/api/emails", emailsRoutes);

// Bunny Stream (mount under /api)
app.use("/api", bunnyStreamRouter);

// Channels
app.use("/api/channels", channelsRouter);

// Playlists (Members can create/share favorites)
app.use("/api/playlists", playlistsRoutes); // ✅ mount once

// NEW: Community (posts, likes, comments, feed)
app.use("/api/community", communityRoutes);

/* ----------------------------
   Health / root
----------------------------- */
app.get("/", (_req, res) => res.send("Bishop Robertson API Running"));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Mobile and TV Apps (plain prefixes for device clients)
app.use("/play", require("./routes/playback"));
app.use("/watch", require("./routes/watch"));
app.use("/devices", require("./routes/devices"));
app.use("/me", require("./routes/library"));

// Comments (legacy site-wide comments, separate from Community)
app.use("/api/comments", require("./routes/comments"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/push", require("./routes/push"));

/* ----------------------------
   Socket.IO — Live chat
----------------------------- */
io.on("connection", (socket) => {
  socket.on("chat:join", ({ eventId, name }) => {
    if (!eventId) return;
    socket.join(`live:${eventId}`);
    socket.data.name = name || "Guest";
  });

  socket.on("chat:message", async (payload = {}, ack) => {
    try {
      const { eventId, message, userId, name } = payload;
      if (!eventId || !message) return ack && ack({ ok: false });

      const ins = await db.query(
        `INSERT INTO live_chat_messages (event_id, user_id, name, message)
         VALUES ($1,$2,$3,$4)
         RETURNING id, created_at`,
        [eventId, userId || null, name || socket.data.name || "Guest", message]
      );

      const msg = {
        id: ins.rows[0].id,
        event_id: eventId,
        user_id: userId || null,
        name: name || socket.data.name || "Guest",
        message,
        created_at: ins.rows[0].created_at,
      };

      io.to(`live:${eventId}`).emit("chat:new", msg);
      ack && ack({ ok: true });
    } catch (e) {
      console.error("socket chat:message error", e);
      ack && ack({ ok: false });
    }
  });
});

/* ----------------------------
   404 / Error handlers
----------------------------- */
app.use("/api", (_req, res, _next) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
});

/* ----------------------------
   Start server
----------------------------- */
// const PORT = process.env.PORT || 5000;
// server.listen(PORT, () => {
//   console.log(`[server] using routes/uploads.js`);
//   console.log(`Server running on port ${PORT}`);
// });
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
