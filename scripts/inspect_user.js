#!/usr/bin/env node
require("dotenv").config();
const db = require("../db");

(async () => {
  try {
    const emails = process.argv.slice(2);
    const list = emails.length
      ? emails
      : [
          "growth.demo@bishoptv.test",
          "essentials.demo@bishoptv.test",
          "custom.demo@bishoptv.test",
        ];

    const { rows: cols } = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='users'
      ORDER BY ordinal_position
    `);
    console.log("User columns:", cols.map((c) => c.column_name).join(", "));

    for (const email of list) {
      const { rows } = await db.query(
        "SELECT * FROM users WHERE lower(email)=lower($1) LIMIT 1",
        [email]
      );
      if (!rows[0]) {
        console.log(`- ${email}: NOT FOUND`);
        continue;
      }
      const u = rows[0];
      console.log(`\n== ${email} ==`);
      console.log("id:", u.id, "role:", u.role);
      console.log("password_hash length:", (u.password_hash || "").length);
      console.log("hashed_password length:", (u.hashed_password || "").length);
      console.log("password prefix:", (u.password || "").slice(0, 4));
    }
    process.exit(0);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
})();
