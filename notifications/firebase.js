// notifications/firebase.js
const admin = require("firebase-admin");

/**
 * We now use FIREBASE_SERVICE_ACCOUNT_JSON
 * which contains the full Firebase service account JSON as ONE STRING.
 * This avoids Render/GitHub formatting issues with private keys.
 */

let serviceAccount = null;

// ---- Parse the JSON safely ----
try {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.error("[firebase] ❌ FIREBASE_SERVICE_ACCOUNT_JSON is missing!");
  } else {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log("[firebase] Loaded FIREBASE_SERVICE_ACCOUNT_JSON");
  }
} catch (err) {
  console.error(
    "[firebase] ❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:",
    err
  );
}

// ---- Initialize Firebase Admin ----
try {
  if (serviceAccount && !admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    console.log("[firebase] ✅ Firebase Admin initialized successfully");
  } else {
    console.error(
      "[firebase] ❌ Admin not initialized — invalid service account"
    );
  }
} catch (err) {
  console.error("[firebase] ❌ Firebase Admin initialization error:", err);
}

// Messaging instance
let fcm = null;

try {
  fcm = admin.messaging();
} catch (err) {
  console.error("[firebase] ❌ Messaging initialization failed:", err);
}

/**
 * Send push notification (mobile / browser FCM tokens)
 */
async function sendPushNotification(token, title, body, data = {}) {
  if (!fcm) {
    console.error("[firebase] ❌ FCM not initialized");
    return { ok: false, error: "FCM not initialized" };
  }

  if (!token) {
    return { ok: false, error: "Missing device token" };
  }

  try {
    const message = {
      token,
      notification:
        title || body ? { title: title || "", body: body || "" } : undefined,
      data: Object.fromEntries(
        Object.entries(data || {}).map(([k, v]) => [k, String(v)])
      ),
    };

    const response = await fcm.send(message);
    console.log("[firebase] 📩 Push sent:", response);

    return { ok: true, response };
  } catch (err) {
    console.error("[firebase] ❌ Push failed:", err);
    return { ok: false, error: err };
  }
}

module.exports = {
  sendPushNotification,
};
