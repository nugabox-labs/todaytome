const crypto = require("crypto");
const express = require("express");
const { prisma } = require("./db");
const { isValidUserId } = require("./validation");
const {
  ok,
  fail,
  toIsoDate,
  formatUser,
  formatRecord,
  formatRecordListItem,
} = require("./response");
const apns = require("./apns");

const router = express.Router();

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || toIsoDate(date) !== value) {
    return null;
  }

  return date;
}

function todayDateOnly() {
  return parseDateOnly(toIsoDate(new Date()));
}

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "todaytome-api",
    time: new Date().toISOString(),
  });
});

router.post("/api/add-user", async (req, res, next) => {
  try {
    const { userId, platform, deviceName, icloudEnabled } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(
        res,
        400,
        "INVALID_USER_ID",
        "userId must be 8 lowercase letters/numbers or iCloud format (_abc123...)"
      );
    }

    const existing = await prisma.user.findUnique({ where: { userId } });
    if (existing) {
      return ok(res, { user: formatUser(existing) });
    }

    const user = await prisma.user.create({
      data: {
        userId,
        platform: platform ?? null,
        deviceName: deviceName ?? null,
        icloudEnabled: Boolean(icloudEnabled),
      },
    });

    return ok(res, { user: formatUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get("/api/user/:userId", async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (!isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return fail(res, 404, "NOT_FOUND", "user not found");
    }

    return ok(res, {
      user: {
        userId: user.userId,
        createdAt: user.createdAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

function isValidHHmm(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

// 자동 표시/알림 설정 저장 — 스케줄러가 지정 시간에 Live Activity를 시작하는 데 사용
router.post("/api/settings", async (req, res, next) => {
  try {
    const {
      userId,
      autoLiveActivity,
      liveActivityTime,
      reminderEnabled,
      reminderTime,
      tzOffsetMinutes,
    } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    const data = {};
    if (typeof autoLiveActivity === "boolean") data.autoLiveActivity = autoLiveActivity;
    if (isValidHHmm(liveActivityTime)) data.liveActivityTime = liveActivityTime;
    if (typeof reminderEnabled === "boolean") data.reminderEnabled = reminderEnabled;
    if (isValidHHmm(reminderTime)) data.reminderTime = reminderTime;
    if (Number.isInteger(tzOffsetMinutes)) data.tzOffsetMinutes = tzOffsetMinutes;

    // 유저가 없으면 설정과 함께 생성, 있으면 설정만 갱신
    const user = await prisma.user.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });

    return ok(res, {
      settings: {
        userId: user.userId,
        autoLiveActivity: user.autoLiveActivity,
        liveActivityTime: user.liveActivityTime,
        reminderEnabled: user.reminderEnabled,
        reminderTime: user.reminderTime,
        tzOffsetMinutes: user.tzOffsetMinutes,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/api/add-record", async (req, res, next) => {
  try {
    const {
      userId,
      subject,
      bible,
      date,
      source = "manual",
    } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    if (!subject || typeof subject !== "string") {
      return fail(res, 400, "VALIDATION_ERROR", "subject is required");
    }

    if (!bible || typeof bible !== "string") {
      return fail(res, 400, "VALIDATION_ERROR", "bible is required");
    }

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return fail(res, 404, "NOT_FOUND", "user not found");
    }

    const recordDate = date ? parseDateOnly(date) : todayDateOnly();
    if (!recordDate) {
      return fail(res, 400, "VALIDATION_ERROR", "date must be YYYY-MM-DD");
    }

    const allowedSources = ["manual", "random", "shortcut", "api", "auto"];
    const recordSource = allowedSources.includes(source) ? source : "manual";

    const record = await prisma.bibleRecord.create({
      data: {
        recordId: `rec_${crypto.randomUUID()}`,
        userId,
        subject: subject.slice(0, 100),
        bible,
        recordDate,
        source: recordSource,
      },
    });

    const formatted = formatRecord(record);

    // Fire-and-forget: send push notifications to all registered devices
    if (apns.isConfigured()) {
      setImmediate(() => pushToUserDevices(userId, formatted).catch(console.error));
    }

    return ok(res, { record: formatted });
  } catch (error) {
    next(error);
  }
});

router.get("/api/today", async (req, res, next) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidUserId(String(userId))) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    const today = todayDateOnly();
    const todayRecord = await prisma.bibleRecord.findFirst({
      where: {
        userId: String(userId),
        recordDate: today,
      },
      orderBy: { createdAt: "desc" },
    });

    if (todayRecord) {
      return ok(res, { today: formatRecord(todayRecord) });
    }

    const latestRecord = await prisma.bibleRecord.findFirst({
      where: { userId: String(userId) },
      orderBy: { createdAt: "desc" },
    });

    return ok(res, {
      today: latestRecord ? formatRecord(latestRecord) : null,
    });
  } catch (error) {
    next(error);
  }
});

router.get("/api/records", async (req, res, next) => {
  try {
    const { userId, limit = "20", offset = "0" } = req.query;

    if (!userId || !isValidUserId(String(userId))) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    const parsedLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const parsedOffset = Math.max(Number(offset) || 0, 0);

    const [records, count] = await Promise.all([
      prisma.bibleRecord.findMany({
        where: { userId: String(userId) },
        orderBy: { createdAt: "desc" },
        take: parsedLimit,
        skip: parsedOffset,
      }),
      prisma.bibleRecord.count({
        where: { userId: String(userId) },
      }),
    ]);

    return ok(res, {
      records: records.map(formatRecordListItem),
      paging: {
        limit: parsedLimit,
        offset: parsedOffset,
        count,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/api/register-device", async (req, res, next) => {
  try {
    const { userId, deviceId, platform, deviceName, apnsToken, apnsEnvironment } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    if (!deviceId) {
      return fail(res, 400, "VALIDATION_ERROR", "deviceId is required");
    }

    const validEnvironment = ["sandbox", "production"].includes(apnsEnvironment) ? apnsEnvironment : null;

    const user = await prisma.user.findUnique({ where: { userId } });
    if (!user) {
      return fail(res, 404, "NOT_FOUND", "user not found");
    }

    await prisma.device.upsert({
      where: {
        deviceId_userId: { deviceId, userId },
      },
      create: {
        deviceId,
        userId,
        platform: platform ?? null,
        deviceName: deviceName ?? null,
        apnsToken: apnsToken ?? null,
        apnsEnvironment: validEnvironment,
      },
      update: {
        platform: platform ?? null,
        deviceName: deviceName ?? null,
        apnsToken: apnsToken ?? null,
        apnsEnvironment: validEnvironment ?? undefined,
      },
    });

    return ok(res, {
      device: {
        userId,
        deviceId,
        platform: platform ?? null,
        deviceName: deviceName ?? null,
        registered: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post("/api/live-activity-token", async (req, res, next) => {
  try {
    const { userId, deviceId, pushToStartToken, activityPushToken } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    if (!deviceId) {
      return fail(res, 400, "VALIDATION_ERROR", "deviceId is required");
    }

    if (!pushToStartToken && !activityPushToken) {
      return fail(res, 400, "VALIDATION_ERROR", "token is required");
    }

    const device = await prisma.device.findUnique({
      where: {
        deviceId_userId: { deviceId, userId },
      },
    });

    if (!device) {
      return fail(res, 404, "NOT_FOUND", "device not found");
    }

    await prisma.device.update({
      where: {
        deviceId_userId: { deviceId, userId },
      },
      data: {
        pushToStartToken: pushToStartToken ?? device.pushToStartToken,
        activityPushToken: activityPushToken ?? device.activityPushToken,
      },
    });

    return ok(res, { saved: true });
  } catch (error) {
    next(error);
  }
});

router.get("/api/shortcut/sample", (req, res) => {
  return ok(res, {
    sample: {
      endpoint: "POST /api/add-record",
      body: {
        userId: "_abc123def456",
        subject: "시편 23:1",
        bible: "여호와는 나의 목자시니 내게 부족함이 없으리로다",
        date: toIsoDate(new Date()),
        source: "shortcut",
      },
    },
  });
});

// Push notifications for all registered devices of a user after a new record
async function pushToUserDevices(userId, record) {
  const devices = await prisma.device.findMany({ where: { userId } });
  console.log(`[push] userId=${userId} devices=${devices.length}`);
  await Promise.allSettled(
    devices.map(async (device) => {
      console.log(`[push] device=${device.deviceId} env=${device.apnsEnvironment ?? "default"} apnsToken=${device.apnsToken ? "yes" : "no"} activityPushToken=${device.activityPushToken ? "yes" : "no"} pushToStartToken=${device.pushToStartToken ? "yes" : "no"}`);
      const env = device.apnsEnvironment;
      // Regular alert push
      if (device.apnsToken) {
        const r = await apns.sendAlertPush(
          device.apnsToken,
          "오늘 나에게",
          "새로운 말씀이 등록되었습니다",
          env
        );
        console.log(`[push] alert result:`, r);
        if (!r.ok && r.reason && r.reason.includes("BadDeviceToken")) {
          await prisma.device.update({
            where: { deviceId_userId: { deviceId: device.deviceId, userId } },
            data: { apnsToken: null },
          });
        }
      }
      // Live Activity: update if active, start if not
      if (device.activityPushToken) {
        const r = await apns.sendLiveActivityUpdate(device.activityPushToken, record, env);
        console.log(`[push] liveActivity update result:`, r);
        // BadDeviceToken = Live Activity already ended — clear stale token and fallback to push-to-start
        if (!r.ok && r.reason && r.reason.includes("BadDeviceToken")) {
          await prisma.device.update({
            where: { deviceId_userId: { deviceId: device.deviceId, userId } },
            data: { activityPushToken: null },
          });
          if (device.pushToStartToken) {
            const r2 = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId, env);
            console.log(`[push] liveActivity fallback start result:`, r2);
            if (!r2.ok && r2.reason && r2.reason.includes("BadDeviceToken")) {
              await prisma.device.update({
                where: { deviceId_userId: { deviceId: device.deviceId, userId } },
                data: { pushToStartToken: null },
              });
            }
          }
        }
      } else if (device.pushToStartToken) {
        const r = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId, env);
        console.log(`[push] liveActivity start result:`, r);
        if (!r.ok && r.reason && r.reason.includes("BadDeviceToken")) {
          await prisma.device.update({
            where: { deviceId_userId: { deviceId: device.deviceId, userId } },
            data: { pushToStartToken: null },
          });
        }
      }
    })
  );
}

// Temp debug: fire a test push to all devices of a user and return results
router.delete("/api/records", async (req, res, next) => {
  try {
    const { userId } = req.query;

    if (!userId || !isValidUserId(String(userId))) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    const { count } = await prisma.bibleRecord.deleteMany({
      where: { userId: String(userId) },
    });

    return ok(res, { deleted: count });
  } catch (error) {
    next(error);
  }
});

router.post("/api/debug/test-push", async (req, res, next) => {
  try {
    const { userId } = req.body;
    if (!userId) return fail(res, 400, "MISSING", "userId required");
    const devices = await prisma.device.findMany({ where: { userId: String(userId) } });
    const fakeRecord = { subject: "푸시 테스트", bible: "테스트 메시지입니다", translation: "개역개정", date: new Date().toISOString().slice(0, 10) };
    const results = await Promise.all(
      devices.map(async (device) => {
        const r = { deviceId: device.deviceId };
        if (device.activityPushToken) {
          r.liveActivity = await apns.sendLiveActivityUpdate(device.activityPushToken, fakeRecord, device.apnsEnvironment);
        } else if (device.pushToStartToken) {
          r.liveActivity = await apns.sendLiveActivityStart(device.pushToStartToken, fakeRecord, userId, device.apnsEnvironment);
        } else {
          r.liveActivity = "no_token";
        }
        return r;
      })
    );
    return ok(res, { results });
  } catch (error) {
    next(error);
  }
});

// Temp debug: check device token state for a user
router.get("/api/debug/devices", async (req, res, next) => {
  try {
    const { userId } = req.query;
    if (!userId) return fail(res, 400, "MISSING", "userId required");
    const devices = await prisma.device.findMany({ where: { userId: String(userId) } });
    return ok(res, {
      devices: devices.map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        apnsEnvironment: d.apnsEnvironment,
        apnsToken: d.apnsToken ? d.apnsToken.slice(0, 8) + "…" : null,
        activityPushToken: d.activityPushToken ? d.activityPushToken.slice(0, 8) + "…" : null,
        pushToStartToken: d.pushToStartToken ? d.pushToStartToken.slice(0, 8) + "…" : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
