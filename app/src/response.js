function ok(res, data = {}) {
  return res.json({ ok: true, data });
}

function fail(res, status, code, message) {
  return res.status(status).json({
    ok: false,
    error: { code, message },
  });
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatUser(user) {
  return {
    userId: user.userId,
    platform: user.platform ?? null,
    deviceName: user.deviceName ?? null,
    icloudEnabled: user.icloudEnabled,
    createdAt: user.createdAt.toISOString(),
  };
}

function formatRecord(record) {
  return {
    id: record.recordId,
    userId: record.userId,
    subject: record.subject,
    bible: record.bible,
    translation: record.translation,
    date: toIsoDate(record.recordDate),
    source: record.source,
    createdAt: record.createdAt.toISOString(),
  };
}

function formatRecordListItem(record) {
  return {
    id: record.recordId,
    subject: record.subject,
    bible: record.bible,
    translation: record.translation,
    date: toIsoDate(record.recordDate),
    source: record.source,
    createdAt: record.createdAt.toISOString(),
  };
}

module.exports = {
  ok,
  fail,
  toIsoDate,
  formatUser,
  formatRecord,
  formatRecordListItem,
};
