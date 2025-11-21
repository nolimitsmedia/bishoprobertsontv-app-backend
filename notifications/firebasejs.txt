// server-api/notifications/firebase.js
const fs = require("fs");
const path = require("path");

let admin = null;
let adminMessaging = null;

function log(...args) {
  console.log("[FCM]", ...args);
}

function tryInitAdmin() {
  if (adminMessaging) return;
  try {
    // Allow path via ENV (recommended)
    const p =
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH ||
      path.join(__dirname, "firebase-service-account.json");

    console.log("[firebase] initialized with:", p);
    const exists = fs.existsSync(p);
    console.log("[firebase] path exists?", exists);
    if (!exists) throw new Error("Service account JSON not found");

    // Lazy require to avoid hard dependency if not used
    admin = require("firebase-admin");
    const sa = require(p);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(sa),
      });
    }
    adminMessaging = admin.messaging();
    log("firebase-admin initialized ✅");
  } catch (e) {
    admin = null;
    adminMessaging = null;
    // Don’t say “pushes disabled” here— we might have SERVER_KEY fallback
    log("Admin init not available:", e?.message || e);
  }
}
tryInitAdmin();

/**
 * Send push to one or more tokens.
 * data: { title, body, data?: {} }
 */
async function sendPushNotification(tokens, { title, body, data = {} } = {}) {
  const list = Array.from(
    new Set((Array.isArray(tokens) ? tokens : [tokens]).filter(Boolean))
  );
  if (!list.length) return { ok: true, sent: 0 };

  // Prefer Admin SDK
  if (adminMessaging) {
    const chunk = 500; // conservative
    let sent = 0;
    for (let i = 0; i < list.length; i += chunk) {
      const batch = list.slice(i, i + chunk);
      const resp = await adminMessaging.sendEachForMulticast({
        tokens: batch,
        notification: title || body ? { title, body } : undefined,
        data,
        android: { priority: "high" },
        apns: { headers: { "apns-priority": "10" } },
      });
      sent += resp.successCount || 0;
    }
    return { ok: true, sent };
  }

  // Fallback to legacy HTTP key if provided
  const key = process.env.FCM_SERVER_KEY || "";
  if (key) {
    const chunk = 500;
    let sent = 0;
    for (let i = 0; i < list.length; i += chunk) {
      const batch = list.slice(i, i + chunk);
      const resp = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `key=${key}`,
        },
        body: JSON.stringify({
          registration_ids: batch,
          notification: title || body ? { title, body } : undefined,
          data,
          android: { priority: "high" },
          apns: { headers: { "apns-priority": "10" } },
        }),
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        log(`legacy send failed ${resp.status}: ${t.slice(0, 200)}`);
      } else {
        sent += list.length; // best effort
      }
    }
    return { ok: true, sent };
  }

  // Nothing available
  log("No Admin SDK or FCM_SERVER_KEY available; skipping send.");
  return { ok: false, sent: 0 };
}

module.exports = { sendPushNotification };
