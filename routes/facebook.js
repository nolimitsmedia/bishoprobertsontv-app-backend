// server-api/routes/facebook.js
const express = require("express");
const axios = require("axios");
const qs = require("querystring");
const crypto = require("crypto");

const pool = require("../db"); // keep as-is

const router = express.Router();

const FB_GRAPH = "https://graph.facebook.com/v20.0";
const FB_DIALOG = "https://www.facebook.com/v20.0/dialog/oauth";

// ---------- Helpers ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function randomState() {
  return crypto.randomBytes(16).toString("hex");
}

// If you already attach req.user/req.admin via your auth middleware, keep it.
// IMPORTANT: popup cannot send auth headers, so /login + /callback must NOT require admin.
function requireAdmin(req, res, next) {
  if (!req.user && !req.admin) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  req.admin = req.admin || req.user;
  next();
}

// Store state in memory (fine for dev/testing).
// state -> { admin_id, returnTo, createdAt }
const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function pruneStates() {
  const now = Date.now();
  for (const [k, v] of stateStore.entries()) {
    if (now - v.createdAt > STATE_TTL_MS) stateStore.delete(k);
  }
}

function isProd() {
  return process.env.NODE_ENV === "production";
}

function getRedirectUri() {
  // Prefer PROD redirect when prod
  const uri = isProd()
    ? process.env.PROD_FACEBOOK_REDIRECT_URI
    : process.env.FACEBOOK_REDIRECT_URI;
  return uri || requireEnv("FACEBOOK_REDIRECT_URI");
}

function getAppPublicUrl() {
  // Where to return after connect
  // Example: http://localhost:5001 or https://nolimitsmedia.github.io/bishoprobertsontv-app
  return isProd()
    ? process.env.PROD_APP_PUBLIC_URL || process.env.APP_PUBLIC_URL
    : process.env.APP_PUBLIC_URL;
}

// ---------- DB helpers ----------
async function getAdminConnection(adminId) {
  const r = await pool.query(
    `SELECT id, admin_id, facebook_user_id, access_token, token_expires_at
     FROM facebook_connections
     WHERE admin_id=$1
     ORDER BY id DESC
     LIMIT 1`,
    [adminId]
  );
  return r.rows[0] || null;
}

// ---------- Status (PUBLIC ok) ----------
router.get("/status", async (req, res) => {
  try {
    // If logged in admin exists, check DB connection
    const admin = req.admin || req.user;
    if (admin?.id) {
      const conn = await getAdminConnection(admin.id);
      return res.json({ ok: true, connected: !!conn, via: "db" });
    }

    // Not logged in? just say not connected (frontend will still show connect button)
    return res.json({ ok: true, connected: false, via: "anon" });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ Start OAuth
 * GET /api/auth/facebook/login?returnTo=<url>
 *
 * This MUST be public because window.open cannot send Authorization headers.
 */
router.get("/login", async (req, res) => {
  try {
    pruneStates();

    const appId = requireEnv("FACEBOOK_APP_ID");
    const redirectUri = getRedirectUri();
    const scopes =
      process.env.FACEBOOK_OAUTH_SCOPES ||
      "email,pages_manage_posts,pages_read_engagement,publish_video";

    const admin = req.admin || req.user; // if you have session/JWT cookies this might exist
    const adminId = admin?.id || null;

    const state = randomState();
    const appPublic = getAppPublicUrl() || "http://localhost:5001";
    const returnTo =
      typeof req.query.returnTo === "string" && req.query.returnTo.length
        ? req.query.returnTo
        : `${appPublic}/#/admin/content/live`;

    stateStore.set(state, {
      admin_id: adminId,
      returnTo,
      createdAt: Date.now(),
    });

    const url =
      `${FB_DIALOG}?` +
      qs.stringify({
        client_id: appId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes,
        state,
      });

    // StreamControl style: redirect immediately (best for popup UX)
    return res.redirect(url);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ✅ OAuth callback
 * GET /api/auth/facebook/callback
 *
 * NOTE: Must be public.
 */
router.get("/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res
        .status(400)
        .send(`Facebook OAuth error: ${error_description || error}`);
    }
    if (!code || !state) {
      return res.status(400).send("Missing code/state.");
    }

    pruneStates();
    const entry = stateStore.get(state);
    if (!entry) return res.status(400).send("Invalid/expired state.");
    stateStore.delete(state);

    const adminId = entry.admin_id; // may be null if no admin context
    const returnTo =
      entry.returnTo || `${getAppPublicUrl()}/#/admin/content/live`;

    const appId = requireEnv("FACEBOOK_APP_ID");
    const appSecret = requireEnv("FACEBOOK_APP_SECRET");
    const redirectUri = getRedirectUri();

    // Exchange code for short-lived user token
    const tokenRes = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      },
      timeout: 15000,
    });

    const shortToken = tokenRes.data.access_token;
    const shortExpiresIn = tokenRes.data.expires_in;

    // Exchange for long-lived token
    const longRes = await axios.get(`${FB_GRAPH}/oauth/access_token`, {
      params: {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken,
      },
      timeout: 15000,
    });

    const longToken = longRes.data.access_token;
    const longExpiresIn = longRes.data.expires_in;

    // Fetch user id
    const meRes = await axios.get(`${FB_GRAPH}/me`, {
      params: { access_token: longToken, fields: "id,name" },
      timeout: 15000,
    });

    const fbUserId = meRes.data.id;

    const expiresAt = longExpiresIn
      ? new Date(Date.now() + longExpiresIn * 1000)
      : shortExpiresIn
      ? new Date(Date.now() + shortExpiresIn * 1000)
      : null;

    // ✅ If we know which admin started the connect, save it
    if (adminId) {
      await pool.query(
        `
        INSERT INTO facebook_connections (admin_id, facebook_user_id, access_token, token_expires_at, created_at, updated_at)
        VALUES ($1, $2, $3, $4, NOW(), NOW())
        ON CONFLICT (admin_id)
        DO UPDATE SET
          facebook_user_id = EXCLUDED.facebook_user_id,
          access_token = EXCLUDED.access_token,
          token_expires_at = EXCLUDED.token_expires_at,
          updated_at = NOW()
        `,
        [adminId, fbUserId, longToken, expiresAt]
      );
    } else {
      // If adminId is null, we still complete OAuth but cannot attach token to a DB row.
      // You can change this later by using a signed cookie/session or passing a nonce.
      console.warn(
        "[facebook/callback] No admin_id in state, token not saved to DB."
      );
    }

    // Redirect back to admin UI
    return res.redirect(`${returnTo}?fb=connected`);
  } catch (err) {
    const msg = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    return res.status(500).send(`OAuth callback failed: ${msg}`);
  }
});

// ---------- 3) List pages (admin-only) ----------
router.get("/pages", requireAdmin, async (req, res) => {
  try {
    const conn = await getAdminConnection(req.admin.id);
    if (!conn)
      return res
        .status(400)
        .json({ ok: false, error: "Facebook not connected." });

    const pagesRes = await axios.get(`${FB_GRAPH}/me/accounts`, {
      params: { access_token: conn.access_token },
      timeout: 15000,
    });

    const pages = (pagesRes.data.data || []).map((p) => ({
      id: p.id,
      name: p.name,
      access_token: p.access_token,
      category: p.category,
      tasks: p.tasks,
    }));

    return res.json({ ok: true, pages });
  } catch (err) {
    const msg = err.response?.data || err.message;
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ---------- 4) Create live video (admin-only) ----------
router.post("/live/create", requireAdmin, async (req, res) => {
  try {
    const { page_id, page_access_token, title, description, status } =
      req.body || {};

    if (!page_id)
      return res.status(400).json({ ok: false, error: "Missing page_id" });

    if (!page_access_token) {
      return res.status(400).json({
        ok: false,
        error: "Missing page_access_token (use GET /pages)",
      });
    }

    const createRes = await axios.post(
      `${FB_GRAPH}/${encodeURIComponent(page_id)}/live_videos`,
      null,
      {
        params: {
          access_token: page_access_token,
          status: status || "LIVE_NOW",
          title: title || "Live Stream",
          description: description || "",
        },
        timeout: 15000,
      }
    );

    const data = createRes.data;

    return res.json({
      ok: true,
      live_video_id: data.id,
      stream_url: data.stream_url,
      secure_stream_url: data.secure_stream_url,
      stream_key: data.stream_key,
    });
  } catch (err) {
    const msg = err.response?.data || err.message;
    return res.status(500).json({ ok: false, error: msg });
  }
});

// ---------- 5) Stop live video (admin-only) ----------
router.post("/live/stop", requireAdmin, async (req, res) => {
  try {
    const { live_video_id, page_access_token } = req.body || {};

    if (!live_video_id)
      return res
        .status(400)
        .json({ ok: false, error: "Missing live_video_id" });

    if (!page_access_token)
      return res
        .status(400)
        .json({ ok: false, error: "Missing page_access_token" });

    const stopRes = await axios.post(
      `${FB_GRAPH}/${encodeURIComponent(live_video_id)}`,
      null,
      {
        params: {
          access_token: page_access_token,
          end_live_video: true,
        },
        timeout: 15000,
      }
    );

    return res.json({ ok: true, result: stopRes.data });
  } catch (err) {
    const msg = err.response?.data || err.message;
    return res.status(500).json({ ok: false, error: msg });
  }
});

module.exports = router;
