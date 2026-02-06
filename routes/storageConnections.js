const express = require("express");
const router = express.Router();
const db = require("../db");
const { encryptJSON } = require("../utils/crypto");

// TODO: replace with your real admin auth middleware
function requireAdmin(req, res, next) {
  // if (!req.user?.is_admin) return res.status(403).json({ ok:false, error:"Forbidden" });
  next();
}

function now() {
  return new Date().toISOString();
}

// Upsert connect
router.post("/connect/:provider", requireAdmin, async (req, res) => {
  const provider = req.params.provider;

  try {
    if (!["wasabi", "bunny"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "Invalid provider" });
    }

    const { meta = {}, secrets = {} } = req.body || {};

    // basic validation (keep strict on required fields)
    if (provider === "wasabi") {
      const requiredMeta = ["region", "endpoint", "bucket"];
      const requiredSecrets = ["accessKeyId", "secretAccessKey"];
      for (const k of requiredMeta)
        if (!meta?.[k])
          return res
            .status(400)
            .json({ ok: false, error: `Missing meta.${k}` });
      for (const k of requiredSecrets)
        if (!secrets?.[k])
          return res
            .status(400)
            .json({ ok: false, error: `Missing secrets.${k}` });
    }

    if (provider === "bunny") {
      const requiredMeta = ["storage_zone", "base_path"];
      const requiredSecrets = ["api_key"];
      for (const k of requiredMeta)
        if (!meta?.[k])
          return res
            .status(400)
            .json({ ok: false, error: `Missing meta.${k}` });
      for (const k of requiredSecrets)
        if (!secrets?.[k])
          return res
            .status(400)
            .json({ ok: false, error: `Missing secrets.${k}` });
    }

    // Ensure only one active row per provider:
    // - mark existing active row inactive
    await db.query(
      `UPDATE storage_connections
       SET is_active = FALSE, status = 'disconnected', secrets_enc = NULL, last_error = NULL
       WHERE provider = $1 AND is_active = TRUE`,
      [provider],
    );

    const secrets_enc = encryptJSON(secrets);

    const r = await db.query(
      `INSERT INTO storage_connections (provider, status, is_active, meta, secrets_enc, last_verified_at, last_error)
       VALUES ($1, 'active', TRUE, $2::jsonb, $3, NULL, NULL)
       RETURNING id, provider, status, is_active, meta, last_verified_at, last_error, created_at, updated_at`,
      [provider, JSON.stringify(meta || {}), secrets_enc],
    );

    return res.json({ ok: true, connection: r.rows[0] });
  } catch (e) {
    console.error("[storage connect] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Disconnect (logout)
router.post("/disconnect/:provider", requireAdmin, async (req, res) => {
  const provider = req.params.provider;

  try {
    if (!["wasabi", "bunny"].includes(provider)) {
      return res.status(400).json({ ok: false, error: "Invalid provider" });
    }

    await db.query(
      `UPDATE storage_connections
       SET status = 'disconnected', is_active = FALSE, secrets_enc = NULL, last_error = NULL, last_verified_at = NULL
       WHERE provider = $1 AND is_active = TRUE`,
      [provider],
    );

    return res.json({
      ok: true,
      message: `${provider} disconnected`,
      at: now(),
    });
  } catch (e) {
    console.error("[storage disconnect] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Get active connections (for admin UI)
router.get("/active", requireAdmin, async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, provider, status, is_active, meta, last_verified_at, last_error, created_at, updated_at
       FROM storage_connections
       WHERE is_active = TRUE
       ORDER BY provider ASC`,
    );
    res.json({ ok: true, connections: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

module.exports = router;
