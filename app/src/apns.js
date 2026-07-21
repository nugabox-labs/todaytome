const http2 = require("http2");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BUNDLE_ID = "com.nugabox.todaytome";
const LIVE_ACTIVITY_TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;

// environment: "sandbox" | "production" | null. Debug(Xcode)로 설치한 기기는 sandbox 토큰,
// TestFlight/App Store(Release)로 설치한 기기는 production 토큰만 유효함 — 잘못된 호스트로
// 보내면 Apple이 무조건 BadDeviceToken으로 거절함. 기기별로 저장된 값을 우선 쓰고,
// 값이 없는(구버전 클라이언트가 등록한) 기기만 APNS_PRODUCTION env로 폴백.
function apnsHost(environment) {
  const isProduction = environment
    ? environment === "production"
    : process.env.APNS_PRODUCTION === "true";
  return isProduction ? "api.push.apple.com" : "api.sandbox.push.apple.com";
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

const REQUEST_TIMEOUT_MS = 8000;

// Open a fresh HTTP/2 connection per push and close it when done. This app sends
// pushes infrequently (at most a few per user per day), so connection reuse isn't
// worth it — a long-lived cached connection can silently die (NAT/idle timeout on
// the host network) while the client still thinks it's open, hanging every push
// sent over it until process restart. A fresh connection avoids that failure mode.
function sendRaw(deviceToken, payload, topic, pushType, environment) {
  return new Promise((resolve) => {
    const jwt = getJWT();
    if (!jwt) {
      console.warn("[APNs] credentials not configured, skipping push");
      return resolve({ ok: false, reason: "no_credentials" });
    }

    const host = apnsHost(environment);
    const body = JSON.stringify(payload);

    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let client;
    try {
      client = http2.connect(`https://${host}`);
    } catch (err) {
      return settle({ ok: false, reason: String(err) });
    }

    const closeClient = () => {
      if (!client.destroyed) client.close();
    };

    client.setTimeout(REQUEST_TIMEOUT_MS, () => {
      console.warn(`[APNs] connection to ${host} timed out`);
      client.destroy();
      settle({ ok: false, reason: "timeout" });
    });
    client.on("error", (err) => {
      console.warn(`[APNs] connection error (${host}):`, err.message);
      settle({ ok: false, reason: err.message });
    });

    const req = client.request({
      ":method": "POST",
      ":path": `/3/device/${deviceToken}`,
      ":scheme": "https",
      ":authority": host,
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
      closeClient();
      if (status === 200) {
        settle({ ok: true });
      } else {
        console.warn(`[APNs] push failed ${status}: ${responseData}`);
        settle({ ok: false, status, reason: responseData });
      }
    });
    req.on("error", (err) => {
      closeClient();
      console.warn("[APNs] request error:", err.message);
      settle({ ok: false, reason: err.message });
    });
    req.write(body);
    req.end();
  });
}

function isConfigured() {
  return !!(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_KEY_PATH);
}

// Send a regular alert push notification (content-available wakes the app to refresh)
function sendAlertPush(apnsToken, title, body, environment) {
  const payload = {
    aps: {
      alert: { title, body },
      sound: "default",
      "content-available": 1,
    },
  };
  return sendRaw(apnsToken, payload, BUNDLE_ID, "alert", environment);
}

// Send Live Activity push-to-start (device has no active Live Activity)
function sendLiveActivityStart(pushToStartToken, record, userId, environment) {
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
        title: "오늘 나에게",
        body: "새로운 말씀이 등록되었습니다",
      },
      sound: "default",
    },
  };
  return sendRaw(pushToStartToken, payload, LIVE_ACTIVITY_TOPIC, "liveactivity", environment);
}

// Send Live Activity update (device has an active Live Activity)
function sendLiveActivityUpdate(activityPushToken, record, environment) {
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
  return sendRaw(activityPushToken, payload, LIVE_ACTIVITY_TOPIC, "liveactivity", environment);
}

module.exports = {
  isConfigured,
  sendAlertPush,
  sendLiveActivityStart,
  sendLiveActivityUpdate,
};
