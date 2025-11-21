// notifications/firebase.js
const admin = require("firebase-admin");

// ---- SAFETY CHECKS ----
if (!process.env.FIREBASE_PROJECT_ID) {
  console.warn("[firebase] FIREBASE_PROJECT_ID missing");
}
if (!process.env.FIREBASE_CLIENT_EMAIL) {
  console.warn("[firebase] FIREBASE_CLIENT_EMAIL missing");
}
if (!process.env.FIREBASE_PRIVATE_KEY) {
  console.warn("[firebase] FIREBASE_PRIVATE_KEY missing");
}

// Remove quotes and fix escaped \n for Render & GitHub env
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey,
      }),
    });

    console.log("[firebase] Admin initialized (env-based)");
  }
} catch (err) {
  console.error("[firebase] Failed to initialize Firebase Admin", err);
}

const fcm = admin.messaging();

/**
 * Send push notification via Firebase Admin SDK
 *
 * Supports:
 *  - Mobile FCM tokens
 *  - Browser push tokens
 *  - Data-only messages for silent updates
 */
async function sendPushNotification(token, title, body, data = {}) {
  try {
    if (!token) {
      console.warn("[firebase] No device token provided");
      return { ok: false };
    }

    const message = {
      token,
      notification:
        title || body ? { title: title || "", body: body || "" } : undefined,

      data: {
        ...Object.fromEntries(
          Object.entries(data || {}).map(([k, v]) => [k, String(v)])
        ),
      },
    };

    const response = await fcm.send(message);
    console.log("[firebase] Push sent:", response);

    return { ok: true, response };
  } catch (err) {
    console.error("[firebase] Push failed:", err);
    return { ok: false, error: err };
  }
}

module.exports = {
  sendPushNotification,
};
