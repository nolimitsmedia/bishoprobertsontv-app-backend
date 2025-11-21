// notifications/fcm.js
const fetch = require("node-fetch");

const FCM_SERVER_KEY = process.env.FCM_SERVER_KEY;

if (!FCM_SERVER_KEY) {
  console.warn("[fcm] Missing FCM_SERVER_KEY in environment");
}

async function sendFCMLegacy(token, title, body, data = {}) {
  try {
    const payload = {
      to: token,
      notification:
        title || body ? { title: title || "", body: body || "" } : undefined,
      data,
    };

    const res = await fetch("https://fcm.googleapis.com/fcm/send", {
      method: "POST",
      headers: {
        Authorization: `key=${FCM_SERVER_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json();
    console.log("[fcm-legacy] Response:", json);
    return json;
  } catch (err) {
    console.error("[fcm-legacy] Error:", err);
    return { error: true };
  }
}

module.exports = {
  sendFCMLegacy,
};
