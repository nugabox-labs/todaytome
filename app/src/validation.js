const { z } = require("zod");

// iCloud userId(_abc123def456) 및 레거시 8자리 ID 모두 허용
const USER_ID_REGEX = /^(?:[a-z0-9]{8}|_[a-z0-9]+)$/;

const userIdSchema = z
  .string()
  .min(1)
  .max(16)
  .refine((value) => USER_ID_REGEX.test(value), {
    message: "userId must be 8 lowercase letters/numbers or iCloud format (_abc123...)",
  });

function isValidUserId(userId) {
  return userIdSchema.safeParse(userId).success;
}

module.exports = {
  USER_ID_REGEX,
  userIdSchema,
  isValidUserId,
};
