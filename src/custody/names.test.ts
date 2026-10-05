import assert from "node:assert/strict";
import { test } from "node:test";
import {
  apiKeySecretSchema,
  isNonblank,
  oauthSecretSchema,
  s3AccessKeySecretSchema,
} from "./contract.ts";
import {
  CREDENTIAL_NAME_MAX_LENGTH,
  RESERVED_NAME_CHECK,
  RESERVED_NAME_LOGIN,
  RESERVED_NAME_PLATFORM,
  validateNameForm,
} from "./names.ts";

test("secret schemas reject unknown fields and blank key material", () => {
  assert.deepEqual(apiKeySecretSchema.parse({ key: "token" }), {
    key: "token",
  });
  assert.equal(apiKeySecretSchema.safeParse({ key: "  " }).success, false);
  assert.equal(
    apiKeySecretSchema.safeParse({ key: "token", extra: 1 }).success,
    false,
  );
  assert.deepEqual(
    oauthSecretSchema.parse({ refresh: " ", access: " ", expires: 0 }),
    {
      refresh: " ",
      access: " ",
      expires: 0,
    },
  );
  assert.equal(
    oauthSecretSchema.safeParse({ refresh: "", access: "a", expires: 1 })
      .success,
    false,
  );
  assert.equal(
    oauthSecretSchema.safeParse({ refresh: "r", access: "", expires: 1 })
      .success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: " ",
      secretAccessKey: "s",
    }).success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: "a",
      secretAccessKey: " ",
    }).success,
    false,
  );
  assert.equal(
    s3AccessKeySecretSchema.safeParse({
      accessKeyId: "a",
      secretAccessKey: "s",
      sessionToken: "t",
    }).success,
    false,
  );
});

test("names must be lower-case, start with a letter and fit in 63 chars", () => {
  assert.equal(validateNameForm("a"), true);
  assert.equal(validateNameForm("valid-name-123"), true);
  assert.equal(validateNameForm("a".repeat(CREDENTIAL_NAME_MAX_LENGTH)), true);
  assert.equal(
    validateNameForm("a".repeat(CREDENTIAL_NAME_MAX_LENGTH + 1)),
    false,
  );
  assert.equal(validateNameForm("1name"), false);
  assert.equal(validateNameForm("Name"), false);
  assert.equal(validateNameForm(""), false);
  assert.equal(validateNameForm("a_b"), false);
  assert.equal(validateNameForm(RESERVED_NAME_LOGIN), true);
  assert.equal(validateNameForm(RESERVED_NAME_PLATFORM), true);
  assert.equal(validateNameForm(RESERVED_NAME_CHECK), true);
  assert.equal(isNonblank("  "), false);
  assert.equal(isNonblank(" a "), true);
});
