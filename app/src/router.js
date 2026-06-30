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

    const allowedSources = ["manual", "random", "shortcut", "api"];
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
    const { userId, deviceId, platform, deviceName, apnsToken } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return fail(res, 400, "INVALID_USER_ID", "userId is invalid");
    }

    if (!deviceId) {
      return fail(res, 400, "VALIDATION_ERROR", "deviceId is required");
    }

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
      },
      update: {
        platform: platform ?? null,
        deviceName: deviceName ?? null,
        apnsToken: apnsToken ?? null,
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
      console.log(`[push] device=${device.deviceId} apnsToken=${device.apnsToken ? "yes" : "no"} activityPushToken=${device.activityPushToken ? "yes" : "no"} pushToStartToken=${device.pushToStartToken ? "yes" : "no"}`);
      // Regular alert push
      if (device.apnsToken) {
        const r = await apns.sendAlertPush(
          device.apnsToken,
          "새로운 말씀",
          "새로운 말씀이 등록되었습니다"
        );
        console.log(`[push] alert result:`, r);
      }
      // Live Activity: update if active, start if not
      if (device.activityPushToken) {
        const r = await apns.sendLiveActivityUpdate(device.activityPushToken, record);
        console.log(`[push] liveActivity update result:`, r);
      } else if (device.pushToStartToken) {
        const r = await apns.sendLiveActivityStart(device.pushToStartToken, record, userId);
        console.log(`[push] liveActivity start result:`, r);
      }
    })
  );
}

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
