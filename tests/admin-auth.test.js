const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPasswordCredential,
  normalizePasswordCredential,
  validatePasswordChange,
  verifyPassword,
  withPreservedCredential,
} = require("../admin-auth.js");

test("validatePasswordChange accepts a complete, matching password change", () => {
  assert.deepEqual(
    validatePasswordChange({
      currentPassword: "Sample-Initial-Password-1",
      newPassword: "Clinic@456",
      confirmPassword: "Clinic@456",
    }),
    { ok: true }
  );
});

test("validatePasswordChange identifies the field that must be corrected", () => {
  const cases = [
    {
      input: { currentPassword: "", newPassword: "Clinic@456", confirmPassword: "Clinic@456" },
      field: "currentPassword",
      code: "CURRENT_REQUIRED",
    },
    {
      input: { currentPassword: "Sample-Initial-Password-1", newPassword: "short", confirmPassword: "short" },
      field: "newPassword",
      code: "NEW_TOO_SHORT",
    },
    {
      input: { currentPassword: "Sample-Initial-Password-1", newPassword: "Clinic@456", confirmPassword: "Different@456" },
      field: "confirmPassword",
      code: "CONFIRM_MISMATCH",
    },
    {
      input: { currentPassword: "Clinic@456", newPassword: "Clinic@456", confirmPassword: "Clinic@456" },
      field: "newPassword",
      code: "PASSWORD_UNCHANGED",
    },
  ];

  cases.forEach(({ input, field, code }) => {
    const result = validatePasswordChange(input);
    assert.equal(result.ok, false);
    assert.equal(result.field, field);
    assert.equal(result.code, code);
  });
});

test("created credentials verify the correct password and reject a wrong password", async () => {
  const credential = await createPasswordCredential("Clinic@456");

  assert.equal(credential.version, 1);
  assert.equal(credential.algorithm, "PBKDF2-SHA-256");
  assert.ok(credential.iterations >= 100000);
  assert.ok(credential.salt.length >= 20);
  assert.ok(credential.hash.length >= 40);
  assert.notEqual(credential.hash, "Clinic@456");
  assert.equal(await verifyPassword("Clinic@456", credential, "Sample-Initial-Password-1"), true);
  assert.equal(await verifyPassword("Wrong@456", credential, "Sample-Initial-Password-1"), false);
});

test("verifyPassword uses the initial password only before a custom credential exists", async () => {
  assert.equal(await verifyPassword("Sample-Initial-Password-1", null, "Sample-Initial-Password-1"), true);
  assert.equal(await verifyPassword("Wrong@456", null, "Sample-Initial-Password-1"), false);
});

test("verifyPassword has no built-in password when no private config is supplied", async () => {
  assert.equal(await verifyPassword("Sample-Initial-Password-1", null), false);
  assert.equal(await verifyPassword("", null), false);
});

test("verifyPassword reads an initial fallback only from explicit private runtime config", async () => {
  const previous = globalThis.APP_CONFIG;
  try {
    globalThis.APP_CONFIG = { INITIAL_ADMIN_PASSWORD: "Local-Only-Password-9" };
    assert.equal(await verifyPassword("Local-Only-Password-9", null), true);
    assert.equal(await verifyPassword("Different-Password-9", null), false);
  } finally {
    if (previous === undefined) delete globalThis.APP_CONFIG;
    else globalThis.APP_CONFIG = previous;
  }
});

test("normalizePasswordCredential rejects malformed cloud credentials", () => {
  assert.equal(normalizePasswordCredential({ version: 1, salt: "bad", hash: "bad" }), null);
  assert.equal(normalizePasswordCredential(null), null);
});

test("withPreservedCredential keeps the cloud password during ordinary admin saves", async () => {
  const credential = await createPasswordCredential("Clinic@456");
  const result = withPreservedCredential(
    { scanTypes: ["Single Tooth"] },
    { adminCredential: credential }
  );

  assert.deepEqual(result.adminCredential, credential);
  assert.notStrictEqual(result.adminCredential, credential);
});
