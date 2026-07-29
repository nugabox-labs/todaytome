const crypto = require("crypto");
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

// 같은 (userId, date) 키에 대한 ensureTodayRecordRaw 호출을 프로세스 안에서 직렬화한다.
// find-then-create는 그 자체로 원자적이지 않아서, 여러 기기가 거의 동시에 앱을 열어
// 같은 순간에 "오늘 기록 없음"을 보고 각자 생성 요청을 보내면(실제로 재현된 적 있음)
// 두 요청의 findFirst가 서로의 create를 못 보고 통과해 중복 레코드가 생길 수 있었다.
// 이 서버는 단일 프로세스(pm2 인스턴스 1개)로만 떠 있으므로, 같은 키의 두 번째 호출이
// 첫 번째 호출의 완료(레코드 커밋)를 기다리게만 해도 경쟁 조건이 완전히 사라진다.
const _locks = new Map();
function withLock(key, fn) {
  const prev = _locks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  _locks.set(key, run.catch(() => {}));
  return run;
}

// 서버 DB에 오늘 기록이 있으면 그 내용을 반환하고, 없으면 결정론적 오늘의 말씀을
// source="auto"로 실제 기록에 남긴다 — 앱을 열지 않은 날도 지난 말씀에 쌓이고,
// 이후 클라이언트가 /api/today로 조회할 때 Live Activity가 보여준 것과 동일한 내용을 받는다
// (클라이언트 로컬 pool과 서버 Notion pool이 달라도 불일치가 생기지 않는다).
// 반환값의 created는 이번 호출에서 새로 만들었는지(=신규 알림을 보낼 가치가 있는지) 나타낸다.
function ensureTodayRecord(userId, dateStr) {
  return withLock(`${userId}|${dateStr}`, () => ensureTodayRecordRaw(userId, dateStr));
}

// record는 Prisma의 원본 BibleRecord 행(그대로 formatRecord()에 넘길 수 있음).
// created=false면 이미 있던 기록을 반환한 것이므로 "새 말씀 등록" 푸시를 또 보내면 안 된다.
async function ensureTodayRecordRaw(userId, dateStr) {
  const recordDate = new Date(`${dateStr}T00:00:00.000Z`);
  const existing = await prisma.bibleRecord.findFirst({
    where: { userId, recordDate },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return { record: existing, created: false };
  }

  const auto = await dailyVerse(dateStr, userId);
  const created = await prisma.bibleRecord.create({
    data: {
      recordId: `rec_${crypto.randomUUID()}`,
      userId,
      subject: auto.subject.slice(0, 100),
      bible: auto.bible,
      translation: auto.translation,
      recordDate,
      source: "auto",
    },
  });
  return { record: created, created: true };
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
        // 죽은 토큰(Live Activity가 이미 종료됨) → 토큰 정리 후 (허용 시) 재시작
        if (apns.isDeadTokenError(r)) {
          await clear("activityPushToken");
          if (allowStart && device.pushToStartToken) {
            const r2 = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId);
            if (apns.isDeadTokenError(r2)) {
              await clear("pushToStartToken");
            }
          }
        }
      } else if (allowStart && device.pushToStartToken) {
        const r = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId);
        if (apns.isDeadTokenError(r)) {
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
      const { record: raw } = await ensureTodayRecord(user.userId, dateStr);
      const record = { subject: raw.subject, bible: raw.bible, translation: raw.translation, date: dateStr };
      await sendLiveActivity(user.userId, record, true).catch(console.error);
    }
    // 자정: 실행 중인 Live Activity만 새 날짜의 말씀으로 갱신 (새로 띄우지 않음)
    else if (isMidnight) {
      const { record: raw } = await ensureTodayRecord(user.userId, dateStr);
      const record = { subject: raw.subject, bible: raw.bible, translation: raw.translation, date: dateStr };
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

module.exports = { start, tick, ensureTodayRecord };
