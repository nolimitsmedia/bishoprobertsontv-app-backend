const { Pool } = require("pg");

// Railway uses internal Postgres without SSL.
// Local development also works without SSL.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
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
