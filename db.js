// server-api/db.js
const { Pool } = require("pg");

// Detect local development properly
const isLocal =
  process.env.LOCAL_DEV === "true" ||
  process.env.NODE_ENV === "development" ||
  process.env.DATABASE_URL?.includes("localhost") ||
  process.env.DATABASE_URL?.includes("127.0.0.1");

// For local dev, disable SSL entirely
// For Railway/Render/Neon/etc, allow self-signed certs
const sslConfig = isLocal
  ? false
  : {
      rejectUnauthorized: false,
    };

// Hard override for local to prevent SSL errors
if (isLocal) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  console.log("[db] TLS override enabled for LOCAL DEV");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig,
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
