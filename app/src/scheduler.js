const { prisma } = require("./db");
const apns = require("./apns");
const { dailyVerse } = require("./verses");

function pad2(n) {
  return String(n).padStart(2, "0");
}

// UTC now에 tz offset(분)을 더해 사용자 로컬 시각(HH:mm)과 날짜(YYYY-MM-DD)를 계산
function localParts(nowUtcMs, tzOffsetMinutes) {
  const local = new Date(nowUtcMs + tzOffsetMinutes * 60000);
  // offset을 이미 더했으므로 UTC 필드가 곧 로컬 값
  const hhmm = `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`;
  const dateStr = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
  return { hhmm, dateStr };
}

// 서버 DB에 오늘 기록이 있으면 그 내용, 없으면 결정론적 오늘의 말씀
async function todayRecordFor(userId, dateStr) {
  const rec = await prisma.bibleRecord.findFirst({
    where: { userId, recordDate: new Date(`${dateStr}T00:00:00.000Z`) },
    orderBy: { createdAt: "desc" },
  });
  if (rec) {
    return { subject: rec.subject, bible: rec.bible, translation: rec.translation, date: dateStr };
  }
  return dailyVerse(dateStr, userId);
}

// 한 유저의 모든 기기에 Live Activity 전송
//   allowStart=true  : 실행 중이면 update, 아니면 push-to-start(신규 시작)
//   allowStart=false : 실행 중(activityPushToken 존재)일 때만 update (신규로 띄우지 않음)
async function sendLiveActivity(userId, record, allowStart) {
  const devices = await prisma.device.findMany({ where: { userId } });
  await Promise.allSettled(
    devices.map(async (device) => {
      const clear = (field) =>
        prisma.device.update({
          where: { deviceId_userId: { deviceId: device.deviceId, userId } },
          data: { [field]: null },
        });

      if (device.activityPushToken) {
        const r = await apns.sendLiveActivityUpdate(device.activityPushToken, record);
        // BadDeviceToken = Live Activity가 이미 종료됨 → 토큰 정리 후 (허용 시) 재시작
        if (!r.ok && r.reason && r.reason.includes("BadDeviceToken")) {
          await clear("activityPushToken");
          if (allowStart && device.pushToStartToken) {
            const r2 = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId);
            if (!r2.ok && r2.reason && r2.reason.includes("BadDeviceToken")) {
              await clear("pushToStartToken");
            }
          }
        }
      } else if (allowStart && device.pushToStartToken) {
        const r = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId);
        if (!r.ok && r.reason && r.reason.includes("BadDeviceToken")) {
          await clear("pushToStartToken");
        }
      }
    })
  );
}

let _lastRunMinute = null;

async function tick() {
  if (!apns.isConfigured()) return;

  const nowMs = Date.now();
  const minuteKey = Math.floor(nowMs / 60000);
  if (_lastRunMinute === minuteKey) return; // 같은 분 중복 실행 방지
  _lastRunMinute = minuteKey;

  const users = await prisma.user.findMany();
  for (const user of users) {
    const tz = Number.isInteger(user.tzOffsetMinutes) ? user.tzOffsetMinutes : 540;
    const { hhmm, dateStr } = localParts(nowMs, tz);

    const isDisplayTime = user.autoLiveActivity && hhmm === (user.liveActivityTime || "00:00");
    const isMidnight = hhmm === "00:00";

    // 표시 시간(자동 표시 On): 실행 중이면 갱신, 아니면 새로 시작
    if (isDisplayTime) {
      const record = await todayRecordFor(user.userId, dateStr);
      await sendLiveActivity(user.userId, record, true).catch(console.error);
    }
    // 자정: 실행 중인 Live Activity만 새 날짜의 말씀으로 갱신 (새로 띄우지 않음)
    else if (isMidnight) {
      const record = await todayRecordFor(user.userId, dateStr);
      await sendLiveActivity(user.userId, record, false).catch(console.error);
    }
  }
}

function start() {
  setInterval(() => {
    tick().catch(console.error);
  }, 60 * 1000);
  console.log("[scheduler] started (60s interval)");
}

module.exports = { start, tick };
