// server-api/lib/dateKey.js
// "YYYY-MM-DD" for a PostgreSQL DATE value. node-postgres returns DATE columns
// as a JavaScript Date at LOCAL midnight, so the calendar day must be read
// with the local getters (toISOString() gives the previous day on a server
// east of UTC, and `${date}` gives "Wed Nov 25 2026 …", which never matches).
function dateKey(v) {
  if (v instanceof Date && !Number.isNaN(v.getTime())) {
    const p = (n) => String(n).padStart(2, "0");
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v || "").slice(0, 10);
}
module.exports = { dateKey };
