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

// Conditional routes (disabled in local mode)
let usageRoutes = null;
let analyticsRoutes = null;

if (!IS_LOCAL) {
  usageRoutes = require("./routes/usage");
  analyticsRoutes = require("./routes/analytics");
} else {
  console.log("[local-dev] usage & analytics disabled");
}

const publicRoutes = require("./routes/public");
const devicesRoutes = require("./routes/devices");
const devEmailRoutes = require("./routes/dev-email");
const emailsRoutes = require("./routes/emails");
const channelsRouter = require("./routes/channels");
const playlistsRoutes = require("./routes/playlists");
const communityRoutes = require("./routes/community");
const authBridge = require("./middleware/auth-bridge");
const bunnyStreamRouter = require("./routes/bunnyStream");

const {
  stripeWebhookHandler,
  paypalWebhookHandler,
} = require("./routes/webhooks");

const app = express();
const server = http.createServer(app);

/* --------------------------------------------------------
   CORS — FULLY FIXED (GitHub Pages + Render + Localhost)
--------------------------------------------------------- */

const baseOrigins = (
  process.env.CLIENT_ORIGIN ||
  "http://localhost:5001,https://nolimitsmedia.github.io,https://nolimitsmedia.github.io/bishoprobertsontv-app"
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

const configuredOrigins = Array.from(
  new Set([...baseOrigins, ...extraOrigins])
);

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

console.log(`[server] CORS allowed origins: ${configuredOrigins.join(", ")}`);

app.set("trust proxy", 1);

app.use(
  cors({
    origin: (origin, cb) =>
      isAllowedOrigin(origin) ? cb(null, true) : cb(new Error("Not allowed")),
    credentials: true,
  })
);

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
  }
);

/* --------------------------------------------------------
   BODY PARSERS
--------------------------------------------------------- */
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(authBridge);

app.use((req, res, next) => {
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
        "public, max-age=600, stale-while-revalidate=600"
      );
    },
  })
);

/* --------------------------------------------------------
   ROUTES
--------------------------------------------------------- */

app.use("/api/auth", authRoutes);
app.use("/api/videos", videosRoutes);
app.use("/api/categories", categoriesRoutes);
app.use("/api/uploads", uploadsRouter);
app.use("/api/upload", uploadsRouter);

app.use("/api/subscription", subscriptionRoutes);
app.use("/api/collections", collectionsRoutes);
app.use("/api/live", liveRoutes);
app.use("/api/live", streamcontrolRoutes);
app.use("/api/streamcontrol", streamcontrolRoutes);
app.use("/api/site", siteRoutes);

app.use("/api", pricingRoutes);
app.use("/api", checkoutRoutes);
app.use("/api/demo", demoRoutes);

if (!IS_LOCAL) {
  app.use("/api/usage", usageRoutes);
  app.use("/api/analytics", analyticsRoutes);
}

app.use("/api", accountRoutes);
app.use("/api/resources", resourcesRoutes);
app.use("/api/public", publicRoutes);

app.use("/api/devices", devicesRoutes);

app.use("/dev", devEmailRoutes);
app.use("/api/emails", emailsRoutes);

app.use("/api", bunnyStreamRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/playlists", playlistsRoutes);
app.use("/api/community", communityRoutes);

app.use("/api/admin/dashboard", adminDashboardRoutes);
app.use("/api/admin/calendar", adminCalendarRoutes);
app.use("/api/admin/resources", adminResourcesRoutes);

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

/* --------------------------------------------------------
   ERRORS
--------------------------------------------------------- */
app.use("/api", (_req, res) => {
  res.status(404).json({ message: "Not found" });
});

app.use((err, _req, res) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Server error" });
});

/* --------------------------------------------------------
   START
--------------------------------------------------------- */
const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || "0.0.0.0";

server.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});
