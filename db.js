// server-api/db.js
const { Pool } = require("pg");

const rawUrl = process.env.DATABASE_URL || "";
if (!rawUrl) {
  console.error("[db] DATABASE_URL is missing.");
}

function parseDbUrl(urlStr) {
  const u = new URL(urlStr);

  // Normalize sslmode if present
  const sslmode = (u.searchParams.get("sslmode") || "").toLowerCase();
  if (sslmode === "verify-full" || sslmode === "verify-ca") {
    u.searchParams.set("sslmode", "require");
    console.log('[db] Overriding sslmode to "require" (was verify-*)');
  }

  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username || ""),
    password: decodeURIComponent(u.password || ""),
    sslmode: (u.searchParams.get("sslmode") || "").toLowerCase(),
  };
}

const cfg = rawUrl ? parseDbUrl(rawUrl) : {};
const isLocalDb = ["localhost", "127.0.0.1", "::1"].includes(cfg.host);

// Optional CA support (recommended if Railway provides it)
// Put PEM into .env as PG_SSL_CA_PEM="-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
const caPem = (process.env.PG_SSL_CA_PEM || "").trim();

// Railway-safe SSL:
// - local DB: OFF
// - remote DB:
//    - if CA provided: verify using CA
//    - else: relaxed (prevents SELF_SIGNED_CERT_IN_CHAIN)
const ssl = isLocalDb
  ? false
  : caPem
    ? { ca: caPem, rejectUnauthorized: true }
    : { rejectUnauthorized: false };

console.log(
  `[db] DB host: ${cfg.host || "(unknown)"} | target: ${
    isLocalDb
      ? "local (SSL OFF)"
      : caPem
        ? "remote (SSL ON w/ CA)"
        : "remote (SSL ON relaxed)"
  }`,
);

// IMPORTANT: Some environments set PGSSLMODE=verify-full and override you.
if (process.env.PGSSLMODE) {
  console.log(`[db] PGSSLMODE is set to "${process.env.PGSSLMODE}"`);
}

const pool = new Pool({
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  user: cfg.user,
  password: cfg.password,

  ssl,

  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

pool.on("error", (e) => {
  console.error("[db] Pool error:", e?.message || e);
});

pool
  .connect()
  .then((client) => {
    console.log("[db] Connected to PostgreSQL");
    client.release();
  })
  .catch((err) => {
    console.error("[db] Connection error", err);
  });

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
