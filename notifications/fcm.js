// server-api/notifications/fcm.js
const admin = require("firebase-admin");
const path = require("path");
const fs = require("fs");

let adminReady = false;

function initAdminOnce() {
  if (adminReady) return;

  try {
    const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT_JSON_PATH;
    if (!svcPath) {
      console.log(
        "[FCM] No FIREBASE_SERVICE_ACCOUNT_JSON_PATH set; FCM push disabled"
      );
      return;
    }

    const absPath = path.isAbsolute(svcPath)
      ? svcPath
      : path.join(__dirname, "..", svcPath);

    console.log("[FCM] using service account JSON:", absPath);
    if (!fs.existsSync(absPath)) {
      console.error("[FCM] Service account file does NOT exist at:", absPath);
      return;
    }

    const serviceAccount = require(absPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    adminReady = true;
    console.log("[FCM] firebase-admin initialized ✅ (service account)");
  } catch (err) {
    console.error("[FCM] firebase-admin init failed:", err.message || err);
  }
}

/**
 * Send a multicast push notification to one or more FCM tokens.
 * tokens: string | string[]
 * payload: { title?: string, body?: string, data?: object }
 */
async function sendPush(tokens, payload = {}) {
  initAdminOnce();
  if (!adminReady) {
    console.log("[FCM] sendPush skipped: admin not ready");
    return;
  }

  const list = Array.isArray(tokens) ? tokens : [tokens];
  const filtered = list.filter(Boolean);

  if (!filtered.length) {
    return;
  }

  const message = {
    tokens: filtered,
    notification: {
      title: payload.title || "Notification",
      body: payload.body || "",
    },
    data: Object.entries(payload.data || {}).reduce((acc, [k, v]) => {
      acc[String(k)] = String(v);
      return acc;
    }, {}),
  };

  try {
    const resp = await admin.messaging().sendEachForMulticast(message);
    console.log(
      `[FCM] sent multicast: success=${resp.successCount}, failure=${resp.failureCount}`
    );
    if (resp.failureCount > 0) {
      resp.responses.forEach((r, idx) => {
        if (!r.success) {
          console.warn(
            "[FCM] token failure",
            filtered[idx],
            r.error?.code,
            r.error?.message
          );
        }
      });
    }
  } catch (err) {
    console.error("[FCM] sendEachForMulticast error:", err.message || err);
  }
}

module.exports = {
  sendPush,
};
