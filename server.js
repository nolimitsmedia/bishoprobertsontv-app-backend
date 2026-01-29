// server-api/server.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

// Detect Local Mode
const IS_LOCAL = process.env.LOCAL_DEV === "true";

console.log(`[server] Local dev mode: ${IS_LOCAL}`);

// DB - always load (safe)
const db = require("./db");

// Firebase (conditionally loaded)
let sendPushNotification = () => {};
if (!IS_LOCAL) {
  try {
    ({ sendPushNotification } = require("./notifications/firebase"));
  } catch (e) {
    console.error("[firebase] Failed to load:", e.message);
  }
} else {
  console.log("[local-dev] Firebase disabled");
}

// Routers
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

const uploadsRouter = require("./routes/upload");
const accountRoutes = require("./routes/account");
const resourcesRoutes = require("./routes/resources");

const adminDashboardRoutes = require("./routes/adminDashboard");
const adminCalendarRoutes = require("./routes/adminCalendar");
const adminResourcesRoutes = require("./routes/adminResources");
const adminOrganizeRoutes = require("./routes/adminOrganize");

const facebookRoutes = require("./routes/facebook");
const integrationsRoutes = require("./routes/integrations");
const bunnyDirectRoutes = require("./routes/bunnyDirect");

// ✅ TUS (optional) – if file doesn't exist yet, don’t crash the server
let tusRouter = null;
try {
  tusRouter = require("./routes/tus");
} catch (e) {
  tusRouter = null;
  console.log("[tus] tus router not found (skipping):", e.message);
}

// Conditional routes
let usageRoutes = null;
let analyticsRoutes = null;

// Usage can remain prod-only if you want
if (!IS_LOCAL) {
  usageRoutes = require("./routes/usage");
} else {
  console.log("[local-dev] usage disabled");
}

// ✅ Analytics should work in local too (needed for Admin Analytics page)
analyticsRoutes = require("./routes/analytics");

const publicRoutes = require("./routes/public");
const devicesRoutes = require("./routes/devices");
const devEmailRoutes = require("./routes/dev-email");
const emailsRoutes = require("./routes/emails");
const channelsRouter = require("./routes/channels");
const playlistsRouter = require("./routes/playlists");
const communityRoutes = require("./routes/community");
const authBridge = require("./middleware/auth-bridge");
const bunnyStreamRouter = require("./routes/bunnyStream");
const pagesRoutes = require("./routes/pages");
const adminAnalyticsRoutes = require("./routes/adminAnalytics");

const {
  stripeWebhookHandler,
  paypalWebhookHandler,
} = require("./routes/webhooks");

const app = express();

// ✅ Avoid favicon hitting your 404 handler
app.get("/favicon.ico", (_req, res) => res.status(204).end());

const server = http.createServer(app);

/* --------------------------------------------------------
   CORS — GitHub Pages + Render + Localhost
   FIXES:
   - Allow x-access-token (and other custom headers)
   - Proper OPTIONS handling without path-to-regexp crashes
--------------------------------------------------------- */

const baseOrigins = (
  process.env.CLIENT_ORIGIN ||
  "http://localhost:5001,https://nolimitsmedia.github.io"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const extraOrigins = [
  process.env.PUBLIC_URL,
  process.env.PUBLIC_BASE_URL,
  process.env.API_BASE,
  process.env.REACT_APP_API_BASE,
  "https://bishoprobertsontv-app.onrender.com",
].filter(Boolean);

// Normalize (remove trailing slash)
const configuredOrigins = Array.from(
  new Set(
    [...baseOrigins, ...extraOrigins].map((o) => String(o).replace(/\/$/, "")),
  ),
);

function isAllowedOrigin(origin) {
  if (!origin) return true; // allow curl/postman/no-origin
  const o = String(origin).replace(/\/$/, "");
  if (configuredOrigins.includes(o)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(o)) return true;
  return false;
}

console.log(`[server] CORS allowed origins: ${configuredOrigins.join(", ")}`);

const corsOptions = {
  origin: (origin, cb) => {
    const ok = isAllowedOrigin(origin);
    if (!ok) {
      console.log(`[CORS BLOCKED] origin=${origin}`);
      // IMPORTANT: return false (don’t throw), so browser gets a clean response
      return cb(null, false);
    }
    return cb(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],

  // ✅ MUST include x-access-token (your login preflight was blocked)
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "x-access-token",
    "x-direct-upload-token",
    "x-upload-token",
    "X-Requested-With",
  ],

  // Some clients send this; harmless to allow
  exposedHeaders: ["Content-Length", "Content-Range", "Content-Disposition"],

  optionsSuccessStatus: 204,
};

app.set("trust proxy", 1);

// ✅ Apply CORS once
app.use(cors(corsOptions));

// ✅ Preflight for any route (NO app.options("*") to avoid path-to-regexp issues)
app.use((req, res, next) => {
  if (req.method === "OPTIONS") {
    // Ensure CORS headers are present
    return cors(corsOptions)(req, res, () => res.sendStatus(204));
  }
  next();
});

/* --------------------------------------------------------
   SOCKET.IO CORS
--------------------------------------------------------- */

const io = new Server(server, {
  cors: {
    origin: (origin, cb) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("Not allowed")),
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
  },
});

app.set("io", io);

/* --------------------------------------------------------
   STRIPE WEBHOOK (RAW)
--------------------------------------------------------- */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res) => {
    req.rawBody = req.body;
    return stripeWebhookHandler(req, res);
  },
);

/* --------------------------------------------------------
   BODY PARSERS
--------------------------------------------------------- */
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));

/**
 * authBridge runs globally (keeps legacy behavior)
 */
app.use(authBridge);

app.use((req, _res, next) => {
  req.db = db;
  next();
});

/* --------------------------------------------------------
   STATIC UPLOADS
--------------------------------------------------------- */
app.use(
  "/uploads",
  express.static(path.join(__dirname, "uploads"), {
    setHeaders: (res) => {
      res.setHeader(
        "Cache-Control",
        "public, max-age=600, stale-while-revalidate=600",
      );
    },
  }),
);

/* --------------------------------------------------------
   FACEBOOK AUTH (Fixes your 404 status)
--------------------------------------------------------- */

app.get("/api/auth/facebook/status", (_req, res) => {
  res.json({ ok: true, connected: false });
});

app.use("/api/auth/facebook", facebookRoutes);

/* --------------------------------------------------------
   ROUTES
--------------------------------------------------------- */

app.use("/api/auth", authRoutes);

app.use("/api/videos", videosRoutes);
app.use("/api/categories", categoriesRoutes);

// ✅ uploads (no limit on multipart sizes; multer config controls max bytes)
app.use("/api/uploads", uploadsRouter);
app.use("/api/upload", uploadsRouter);

app.use("/api/subscription", subscriptionRoutes);
app.use("/api/collections", collectionsRoutes);

app.use("/api/live", liveRoutes);
app.use("/api/streamcontrol", streamcontrolRoutes); // keep clean single mount

app.use("/api/site", siteRoutes);

app.use("/api", pricingRoutes);
app.use("/api", checkoutRoutes);
app.use("/api/demo", demoRoutes);

app.use("/api/uploads/bunny", bunnyDirectRoutes);

// ✅ usage stays prod-only
if (!IS_LOCAL && usageRoutes) {
  app.use("/api/usage", usageRoutes);
}

// ✅ analytics always enabled (fixes 404 in local)
app.use("/api/analytics", analyticsRoutes);

app.use("/api", accountRoutes);
app.use("/api/resources", resourcesRoutes);

// public misc routes
app.use("/api/public", publicRoutes);

app.use("/api/devices", devicesRoutes);

app.use("/dev", devEmailRoutes);
app.use("/api/emails", emailsRoutes);

app.use("/api", bunnyStreamRouter);

app.use("/api/channels", channelsRouter);

// ✅ playlists router (admin + public endpoints live here)
app.use("/api/playlists", playlistsRouter);

// ✅ community
app.use("/api/community", communityRoutes);

// ✅ admin routes
app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin/calendar", adminCalendarRoutes);
app.use("/api/admin/resources", adminResourcesRoutes);
app.use("/api/admin/organize", adminOrganizeRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api", pagesRoutes);
app.use("/api/admin/analytics", adminAnalyticsRoutes);

/**
 * ✅ Compatibility alias for Catalog.js:
 * Frontend calls:  /api/public/collections?limit=1000
 * We forward it to: /api/playlists/public?limit=1000
 */
app.use("/api/public/collections", (req, res, next) => {
  req.url = "/public" + (req.url || "");
  return playlistsRouter(req, res, next);
});

/* --------------------------------------------------------
   HEALTH
--------------------------------------------------------- */
app.get("/", (_req, res) => res.send("Bishop Robertson API Running"));
app.get("/api/health", (_req, res) => res.json({ ok: true }));

/* --------------------------------------------------------
   DEVICE ROUTES
--------------------------------------------------------- */
app.use("/play", require("./routes/playback"));
app.use("/watch", require("./routes/watch"));
app.use("/devices", require("./routes/devices"));
app.use("/me", require("./routes/library"));

app.use("/api/comments", require("./routes/comments"));
app.use("/api/notifications", require("./routes/notifications"));
app.use("/api/push", require("./routes/push"));

// ✅ TUS endpoint (only mounts if ./routes/tus exists)
if (tusRouter) {
  app.use("/api/uploads/tus", tusRouter);
}

/* --------------------------------------------------------
   SOCKET.IO CHAT
--------------------------------------------------------- */
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
        [eventId, userId || null, name || socket.data.name || "Guest", message],
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

/* --------------------------------------------------------
   ERRORS
--------------------------------------------------------- */

app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ ok: false, error: "Server error" });
});

/* --------------------------------------------------------
   START
--------------------------------------------------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
