// server-api/db.js
const { Pool } = require("pg");

// Determine SSL usage:
// - Production (Render) → Railway requires SSL
// - Local development → No SSL
const isProduction = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction
    ? { rejectUnauthorized: false } // Required for Railway public connections
    : false,
});

// Test connection on startup
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
