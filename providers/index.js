// server-api/providers/index.js
let livepeer;
try {
  livepeer = require("./livepeer");
} catch {}
const streamcontrol = require("./streamcontrol");

function pick(name) {
  const n = String(name || "").toLowerCase();
  if (n === "streamcontrol") return streamcontrol;
  if (n === "livepeer" && livepeer) return livepeer;
  // default
  return streamcontrol;
}

module.exports = { pick };
