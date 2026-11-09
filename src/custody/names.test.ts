import assert from "node:assert/strict";
import { test } from "node:test";
import { CREDENTIAL_NAME_MAX_LENGTH, isNonblank } from "./contract.ts";
import {
  RESERVED_NAME_CHECK,
  RESERVED_NAME_LOGIN,
  RESERVED_NAME_PLATFORM,
  validateNameForm,
} from "./names.ts";

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
