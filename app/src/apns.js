const http2 = require("http2");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BUNDLE_ID = "com.nugabox.todaytome";
const LIVE_ACTIVITY_TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;

function apnsHost() {
  return process.env.APNS_PRODUCTION === "true"
    ? "api.push.apple.com"
    : "api.sandbox.push.apple.com";
}

// JWT cache — Apple requires token to be < 60 min old; we refresh every 45 min
let _jwtCache = { token: null, issuedAt: 0 };

function getJWT() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache.token && now - _jwtCache.issuedAt < 2700) {
    return _jwtCache.token;
  }

  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const keyPath = process.env.APNS_KEY_PATH;

  if (!keyId || !teamId || !keyPath) return null;

  let privateKey;
  try {
    privateKey = fs.readFileSync(path.resolve(keyPath), "utf8");
  } catch {
    return null;
  }

  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: teamId, iat: now })).toString("base64url");
  const signing = `${header}.${payload}`;

  const sign = crypto.createSign("SHA256");
  sign.update(signing);
  // ieee-p1363 gives raw R||S format required by JWT ES256
  const signature = sign.sign({ key: privateKey, dsaEncoding: "ieee-p1363" }, "base64url");

  const token = `${signing}.${signature}`;
  _jwtCache = { token, issuedAt: now };
  return token;
}

// Reuse HTTP/2 connection per host
const _clients = {};
function getClient() {
  const host = apnsHost();
  if (_clients[host] && !_clients[host].destroyed) return _clients[host];
  const client = http2.connect(`https://${host}`);
  client.on("error", () => { delete _clients[host]; });
  client.on("close", () => { delete _clients[host]; });
  _clients[host] = client;
  return client;
}

function sendRaw(deviceToken, payload, topic, pushType) {
  return new Promise((resolve) => {
    const jwt = getJWT();
    if (!jwt) {
      console.warn("[APNs] credentials not configured, skipping push");
      return resolve({ ok: false, reason: "no_credentials" });
    }

    const body = JSON.stringify(payload);
    let client;
    try {
      client = getClient();
    } catch (err) {
      return resolve({ ok: false, reason: String(err) });
    }

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      ":scheme": "https",
      ":authority": apnsHost(),
      authorization: `bearer ${jwt}`,
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "apns-topic": topic,
      "apns-push-type": pushType,
      "apns-expiration": "0",
      "apns-priority": "10",
    });

    let responseData = "";
    let status = 200;

    req.on("response", (headers) => { status = headers[":status"]; });
    req.on("data", (chunk) => { responseData += chunk; });
    req.on("end", () => {
      if (status === 200) {
        resolve({ ok: true });
      } else {
        console.warn(`[APNs] push failed ${status}: ${responseData}`);
        resolve({ ok: false, status, reason: responseData });
      }
    });
    req.on("error", (err) => {
      console.warn("[APNs] request error:", err.message);
      resolve({ ok: false, reason: err.message });
    });
    req.write(body);
    req.end();
  });
}

function isConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_PATH);
}

// Send a regular alert push notification (content-available wakes the app to refresh)
function sendAlertPush(apnsToken, title, body) {
  const payload = {
    aps: {
      alert: { title, body },
      sound: "default",
      "content-available": 1,
    },
  };
  return sendRaw(apnsToken, payload, BUNDLE_ID, "alert");
}

// Send Live Activity push-to-start (device has no active Live Activity)
function sendLiveActivityStart(pushToStartToken, record, userId) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: "start",
      "content-state": {
        subject: record.subject,
        bible: record.bible,
        translation: record.translation,
        date: record.date,
        updatedAt: now,
      },
      "attributes-type": "TodayVerseAttributes",
      attributes: {
        userId,
        appName: "오늘 나에게",
      },
      alert: {
        title: "새로운 말씀",
        body: "새로운 말씀이 등록되었습니다",
      },
      sound: "default",
    },
  };
  return sendRaw(pushToStartToken, payload, LIVE_ACTIVITY_TOPIC, "liveactivity");
}

// Send Live Activity update (device has an active Live Activity)
function sendLiveActivityUpdate(activityPushToken, record) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aps: {
      timestamp: now,
      event: "update",
      "content-state": {
        subject: record.subject,
        bible: record.bible,
        translation: record.translation,
        date: record.date,
        updatedAt: now,
      },
    },
  };
  return sendRaw(activityPushToken, payload, LIVE_ACTIVITY_TOPIC, "liveactivity");
}

module.exports = {
  isConfigured,
  sendAlertPush,
  sendLiveActivityStart,
  sendLiveActivityUpdate,
};
