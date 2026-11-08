import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { ResultClass } from "./contract.ts";
import { Platform } from "./credential-platform.ts";
import { platformFailure } from "./platform-failure.ts";

const MESSAGE = "The Jira call failed.";
const GATEWAY_STATUS = 503;
const BAD_GATEWAY_STATUS = 502;
const RETRYABLE_CODE = "intake.platform.jira.retryable_refusal";
const UNKNOWN_CODE = "intake.platform.jira.unknown_outcome";

test("a failed platform call answers 502 with the family code and the status", () => {
  const error = platformFailure(Platform.Jira, {
    class: ResultClass.RetryableRefusal,
    message: MESSAGE,
    status: GATEWAY_STATUS,
  });
  assert.ok(error instanceof OperationError);
  assert.equal(error.status, BAD_GATEWAY_STATUS);
  assert.equal(error.code, RETRYABLE_CODE);
  assert.equal(error.message, MESSAGE);
  assert.deepEqual(error.details, { status: GATEWAY_STATUS });
});

test("a failure with no HTTP status answers a null status", () => {
  const error = platformFailure(Platform.Jira, {
    class: ResultClass.UnknownOutcome,
    message: MESSAGE,
    status: null,
  });
  assert.equal(error.code, UNKNOWN_CODE);
  assert.deepEqual(error.details, { status: null });
});
