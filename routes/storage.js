// server-api/routes/storage.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const { encryptJSON } = require("../utils/crypto");
const { requireAuth, requireAdmin } = require("../middleware/auth");

function normPrefix(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  return s.replace(/^\/+/, "").replace(/\/+$/, "") + "/";
}

function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function mustStr(v) {
  return String(v || "").trim();
}

function assertNonEmpty(val, msg) {
  if (!val || !String(val).trim()) throw new Error(msg);
}

/**
 * GET /api/admin/storage/active
 * Returns currently active connections (one per provider).
 * NOTE: DB uses `config`, but frontend expects `meta` in some places,
 * so we return BOTH: meta + config for safety.
 */
router.get("/active", requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await db.query(`
      SELECT
        id,
        provider,
        name,
        config,
        is_active,
        last_test_ok,
        last_test_at,
        last_test_error,
        created_at,
        updated_at
      FROM storage_connections
      WHERE is_active = TRUE
      ORDER BY provider ASC
    `);

    const connections = (r.rows || []).map((row) => ({
      ...row,
      // Back-compat for UI code that uses `meta`
      meta: row.config || {},
    }));

    return res.json({ ok: true, connections });
  } catch (e) {
    console.error("[storage/active] error:", e);
    return res
      .status(500)
      .json({ ok: false, message: e.message || "Server error" });
  }
});

/**
 * POST /api/admin/storage/connect/:provider
 * body: { meta: {...}, secrets: {...} }
 * Saves as active (one per provider).
 */
router.post(
  "/connect/:provider",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();
    const body = req.body || {};
    const metaIn = body.meta || {};
    const secretsIn = body.secrets || {};

    try {
      if (!["wasabi", "bunny"].includes(provider)) {
        return res.status(400).json({ ok: false, message: "Invalid provider" });
      }

      // Build normalized config object
      const config = { ...metaIn };

      // Validate + normalize by provider
      if (provider === "wasabi") {
        config.region = mustStr(config.region || "us-east-1");
        config.endpoint = mustStr(
          config.endpoint || "https://s3.us-east-1.wasabisys.com",
        );
        config.bucket = mustStr(config.bucket);

        config.import_prefix = config.import_prefix
          ? normPrefix(config.import_prefix)
          : "";
        config.access_mode = String(config.access_mode || "auto").toLowerCase();
        if (!["auto", "public", "private"].includes(config.access_mode)) {
          config.access_mode = "auto";
        }

        config.signed_url_ttl_seconds = safeInt(
          config.signed_url_ttl_seconds,
          3600,
        );
        config.signed_url_ttl_seconds = Math.max(
          60,
          Math.min(86400, config.signed_url_ttl_seconds),
        );

        assertNonEmpty(config.endpoint, "Missing meta.endpoint");
        assertNonEmpty(config.bucket, "Missing meta.bucket");
        assertNonEmpty(config.region, "Missing meta.region");

        // Required secrets
        const accessKeyId = mustStr(secretsIn.accessKeyId);
        const secretAccessKey = mustStr(secretsIn.secretAccessKey);

        assertNonEmpty(accessKeyId, "Missing secrets.accessKeyId");
        assertNonEmpty(secretAccessKey, "Missing secrets.secretAccessKey");

        // Force cleaned secrets object
        secretsIn.accessKeyId = accessKeyId;
        secretsIn.secretAccessKey = secretAccessKey;
      }

      if (provider === "bunny") {
        config.storage_zone = mustStr(config.storage_zone);
        config.host = mustStr(config.host || "ny.storage.bunnycdn.com");
        config.base_path = mustStr(config.base_path);
        config.cdn_base_url = mustStr(config.cdn_base_url || "");

        assertNonEmpty(config.storage_zone, "Missing meta.storage_zone");
        assertNonEmpty(config.host, "Missing meta.host");
        assertNonEmpty(config.base_path, "Missing meta.base_path");

        const api_key = mustStr(secretsIn.api_key);
        assertNonEmpty(api_key, "Missing secrets.api_key");
        secretsIn.api_key = api_key;
      }

      // Encrypt secrets (MUST NOT be null due to NOT NULL constraint)
      const secrets_enc = encryptJSON(secretsIn);
      if (!secrets_enc) {
        throw new Error(
          "Encryption failed: secrets_enc is empty. Check APP_ENCRYPTION_KEY and utils/crypto.js",
        );
      }

      // Ensure only one active per provider: deactivate old
      await db.query(
        `
      UPDATE storage_connections
      SET
        is_active = FALSE,
        updated_at = now()
      WHERE provider = $1 AND is_active = TRUE
      `,
        [provider],
      );

      // Helpful display name
      let name = "";
      if (provider === "wasabi") name = `Wasabi (${config.bucket || "bucket"})`;
      if (provider === "bunny")
        name = `Bunny (${config.storage_zone || "zone"})`;

      // Insert new active connection
      const ins = await db.query(
        `
      INSERT INTO storage_connections
        (provider, name, config, secrets_enc, is_active, created_at, updated_at)
      VALUES
        ($1, $2, $3::jsonb, $4, TRUE, now(), now())
      RETURNING
        id, provider, name, config, is_active,
        last_test_ok, last_test_at, last_test_error,
        created_at, updated_at
      `,
        [provider, name, JSON.stringify(config || {}), secrets_enc],
      );

      const connection = ins.rows[0]
        ? { ...ins.rows[0], meta: ins.rows[0].config || {} }
        : null;

      return res.json({ ok: true, connection });
    } catch (e) {
      console.error("[storage/connect] error:", e);
      return res
        .status(500)
        .json({ ok: false, message: e.message || "Server error" });
    }
  },
);

/**
 * POST /api/admin/storage/disconnect/:provider
 * Disables the active connection and clears secrets.
 * NOTE: schema has secrets_enc NOT NULL, so we cannot set it to NULL.
 * We'll keep the record but set is_active FALSE and replace secrets_enc with encrypted {}.
 */
router.post(
  "/disconnect/:provider",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const provider = String(req.params.provider || "").toLowerCase();

    try {
      if (!["wasabi", "bunny"].includes(provider)) {
        return res.status(400).json({ ok: false, message: "Invalid provider" });
      }

      // Because secrets_enc is NOT NULL, we store encrypted empty object instead of NULL.
      const emptySecretsEnc = encryptJSON({});

      await db.query(
        `
        UPDATE storage_connections
        SET
          is_active = FALSE,
          secrets_enc = $2,
          last_test_ok = FALSE,
          last_test_at = NULL,
          last_test_error = NULL,
          updated_at = now()
        WHERE provider = $1 AND is_active = TRUE
        `,
        [provider, emptySecretsEnc],
      );

      return res.json({ ok: true, message: `${provider} disconnected` });
    } catch (e) {
      console.error("[storage/disconnect] error:", e);
      return res
        .status(500)
        .json({ ok: false, message: e.message || "Server error" });
    }
  },
);

/**
 * POST /api/admin/storage/test/:provider
 * Verifies config without saving (if body provided),
 * or verifies saved active config (if body omitted).
 */
router.post("/test/:provider", requireAuth, requireAdmin, async (req, res) => {
  const provider = String(req.params.provider || "").toLowerCase();

  try {
    if (!["wasabi", "bunny"].includes(provider)) {
      return res.status(400).json({ ok: false, message: "Invalid provider" });
    }

    if (provider === "wasabi") {
      const wasabi = require("../services/importer/providers/importWasabi");
      const out = await wasabi.testConnection(req.body || null);
      return res.json({ ok: true, ...out });
    }

    const bunny = require("../services/importer/providers/bunny");
    const out = await bunny.testConnection(req.body || null);
    return res.json({ ok: true, ...out });
  } catch (e) {
    return res
      .status(400)
      .json({ ok: false, message: e.message || "Test failed" });
  }
});

module.exports = router;
