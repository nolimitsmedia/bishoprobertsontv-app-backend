// server-api/lib/signBunny.js
// Bunny CDN token auth (basic MD5 variant) – see docs
// https://docs.bunny.net/docs/cdn-token-authentication-basic
const crypto = require("crypto");

/**
 * @param {string} urlPath e.g. "/my-hls/video.m3u8"
 * @param {number} expiresEpoch e.g. Math.floor(Date.now()/1000)+3600
 * @param {string} securityKey your Pull Zone Security Key
 * @returns {{token:string, expires:number}}
 */
function signBunnyUrl(urlPath, expiresEpoch, securityKey) {
  const base = securityKey + urlPath + expiresEpoch;
  const token = crypto.createHash("md5").update(base).digest("hex");
  return { token, expires: expiresEpoch };
}

module.exports = { signBunnyUrl };
