// server-api/routes/integrations.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const db = require("../db");
const authenticate = require("../middleware/authenticate");

/**
 * ENV REQUIRED (Google):
 * GOOGLE_CLIENT_ID=...
 * GOOGLE_CLIENT_SECRET=...
 * GOOGLE_REDIRECT_URI=https://YOUR_BACKEND_DOMAIN/api/integrations/google/callback
 *
 * Optional:
 * INTEGRATIONS_REDIRECT_SUCCESS=http://localhost:5001/#/admin/content/integrations?connected=google&ok=1
 * INTEGRATIONS_REDIRECT_ERROR=http://localhost:5001/#/admin/content/integrations?connected=google&ok=0&error=...
 *
 * If not set, we try CLIENT_ORIGIN (first item) and fall back to http://localhost:5001
 */

// ------------------------- helpers -------------------------

function getClientBase() {
  const raw =
    process.env.CLIENT_ORIGIN ||
    process.env.PUBLIC_URL ||
    process.env.REACT_APP_PUBLIC_URL ||
    "http://localhost:5001";

  const first = String(raw).split(",")[0].trim();
  return first || "http://localhost:5001";
}

function defaultSuccessRedirect(provider = "google") {
  const base = getClientBase().replace(/\/+$/g, "");
  // HashRouter-friendly:
  return `${base}/#/admin/content/integrations?connected=${encodeURIComponent(
    provider
  )}&ok=1`;
}

function defaultErrorRedirect(provider = "google", message = "oauth_failed") {
  const base = getClientBase().replace(/\/+$/g, "");
  return `${base}/#/admin/content/integrations?connected=${encodeURIComponent(
    provider
  )}&ok=0&error=${encodeURIComponent(message)}`;
}

function buildRedirectUrl(ok, provider, errMsg) {
  if (ok) {
    return (
      process.env.INTEGRATIONS_REDIRECT_SUCCESS ||
      defaultSuccessRedirect(provider)
    );
  }
  const fallback = defaultErrorRedirect(provider, errMsg || "oauth_failed");
  return process.env.INTEGRATIONS_REDIRECT_ERROR || fallback;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function randomState() {
  return crypto.randomBytes(24).toString("hex");
}

async function saveOauthState({ userId, provider, state, ttlMinutes = 10 }) {
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await db.query(
    `INSERT INTO oauth_states (user_id, provider, state, expires_at)
     VALUES ($1,$2,$3,$4)`,
    [userId, provider, state, expiresAt]
  );
}

async function consumeOauthState({ provider, state }) {
  // Atomically validate + delete
  const r = await db.query(
    `DELETE FROM oauth_states
     WHERE provider = $1
       AND state = $2
       AND expires_at > NOW()
     RETURNING user_id`,
    [provider, state]
  );
  return r.rows[0]?.user_id || null;
}

async function upsertToken({
  userId,
  provider,
  access_token,
  refresh_token,
  token_type,
  scope,
  expiry_date,
  raw_json,
}) {
  await db.query(
    `
    INSERT INTO integration_tokens
      (user_id, provider, access_token, refresh_token, token_type, scope, expiry_date, raw_json)
    VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, integration_tokens.refresh_token),
      token_type = EXCLUDED.token_type,
      scope = EXCLUDED.scope,
      expiry_date = EXCLUDED.expiry_date,
      raw_json = EXCLUDED.raw_json,
      updated_at = NOW()
    `,
    [
      userId,
      provider,
      access_token || null,
      refresh_token || null,
      token_type || null,
      scope || null,
      expiry_date || null,
      raw_json ? JSON.stringify(raw_json) : null,
    ]
  );
}

async function deleteToken(userId, provider) {
  await db.query(
    `DELETE FROM integration_tokens WHERE user_id=$1 AND provider=$2`,
    [userId, provider]
  );
}

// ------------------------- STATUS -------------------------

/**
 * GET /api/integrations/status
 * returns whether connected
 */
router.get("/status", authenticate, async (req, res) => {
  try {
    const userId = req.user?.id;
    const r = await db.query(
      `SELECT provider
       FROM integration_tokens
       WHERE user_id=$1`,
      [userId]
    );
    const set = new Set(r.rows.map((x) => x.provider));

    res.json({
      ok: true,
      googleDrive: set.has("google_drive"),
      dropbox: set.has("dropbox"),
    });
  } catch (e) {
    console.error("[integrations/status] error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ------------------------- GOOGLE DRIVE -------------------------

/**
 * POST /api/integrations/google/connect
 * returns { url }
 */
router.post("/google/connect", authenticate, async (req, res) => {
  try {
    const clientId = mustEnv("GOOGLE_CLIENT_ID");
    const redirectUri = mustEnv("GOOGLE_REDIRECT_URI");

    const state = randomState();
    await saveOauthState({
      userId: req.user.id,
      provider: "google_drive",
      state,
      ttlMinutes: 10,
    });

    // Minimal scopes for Drive picker/list/download
    // You can expand later as needed.
    const scope = [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ].join(" ");

    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("scope", scope);
    authUrl.searchParams.set("access_type", "offline"); // for refresh token
    authUrl.searchParams.set("prompt", "consent"); // ensure refresh token on repeat connects
    authUrl.searchParams.set("include_granted_scopes", "true");
    authUrl.searchParams.set("state", state);

    return res.json({ ok: true, url: authUrl.toString() });
  } catch (e) {
    console.error("[google/connect] error:", e);
    return res.status(500).json({ ok: false, message: e.message || "Error" });
  }
});

/**
 * GET /api/integrations/google/callback
 * exchanges code for tokens and stores them
 */
router.get("/google/callback", async (req, res) => {
  const provider = "google";
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    const err = String(req.query.error || "");

    if (err) {
      return res.redirect(buildRedirectUrl(false, provider, err));
    }
    if (!code || !state) {
      return res.redirect(
        buildRedirectUrl(false, provider, "missing_code_or_state")
      );
    }

    // Validate state -> get userId
    const userId = await consumeOauthState({
      provider: "google_drive",
      state,
    });
    if (!userId) {
      return res.redirect(buildRedirectUrl(false, provider, "invalid_state"));
    }

    const clientId = mustEnv("GOOGLE_CLIENT_ID");
    const clientSecret = mustEnv("GOOGLE_CLIENT_SECRET");
    const redirectUri = mustEnv("GOOGLE_REDIRECT_URI");

    // Exchange code for tokens
    const body = new URLSearchParams();
    body.set("code", code);
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
    body.set("redirect_uri", redirectUri);
    body.set("grant_type", "authorization_code");

    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!tokenResp.ok) {
      const t = await tokenResp.text().catch(() => "");
      console.error(
        "[google/callback] token exchange failed:",
        tokenResp.status,
        t
      );
      return res.redirect(
        buildRedirectUrl(false, provider, "token_exchange_failed")
      );
    }

    const tokenJson = await tokenResp.json();

    const access_token = tokenJson.access_token || null;
    const refresh_token = tokenJson.refresh_token || null;
    const token_type = tokenJson.token_type || null;
    const scope = tokenJson.scope || null;

    // expires_in is seconds from now
    const expiry_date = tokenJson.expires_in
      ? new Date(Date.now() + Number(tokenJson.expires_in) * 1000)
      : null;

    await upsertToken({
      userId,
      provider: "google_drive",
      access_token,
      refresh_token,
      token_type,
      scope,
      expiry_date,
      raw_json: tokenJson,
    });

    return res.redirect(buildRedirectUrl(true, provider));
  } catch (e) {
    console.error("[google/callback] error:", e);
    return res.redirect(buildRedirectUrl(false, provider, "callback_failed"));
  }
});

/**
 * POST /api/integrations/google/disconnect
 */
router.post("/google/disconnect", authenticate, async (req, res) => {
  try {
    await deleteToken(req.user.id, "google_drive");
    res.json({ ok: true });
  } catch (e) {
    console.error("[google/disconnect] error:", e);
    res.status(500).json({ ok: false, message: "Server error" });
  }
});

// ------------------------- DROPBOX (STUBS - next) -------------------------

router.post("/dropbox/connect", authenticate, async (_req, res) => {
  // Next step: return Dropbox auth URL + state, same pattern as google
  res
    .status(501)
    .json({ ok: false, message: "Dropbox connect not implemented yet" });
});

router.get("/dropbox/callback", async (_req, res) => {
  res.status(501).send("Dropbox callback not implemented yet");
});

router.post("/dropbox/disconnect", authenticate, async (_req, res) => {
  res
    .status(501)
    .json({ ok: false, message: "Dropbox disconnect not implemented yet" });
});

module.exports = router;
