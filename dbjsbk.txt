const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // e.g., postgres://user:pass@host:port/bishoprobertson_db
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

module.exports = pool;
