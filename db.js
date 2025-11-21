// server-api/db.js
const { Pool } = require("pg");

const isRender = !!process.env.RENDER;
const isRailway = process.env.DATABASE_URL?.includes("railway");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isRailway
    ? {
        rejectUnauthorized: false, // required for Railway SSL
      }
    : false,
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
