import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionKind } from "../tracking/contract.ts";
import { executionOpening } from "./telemetry.ts";

const QUEUED_AT = 10000;
const CLAIMED_AT = 12500;
const NO_WAIT = 0;

test("the root start facts hold the kind, the worker name and the wait", () => {
  assert.deepEqual(
    executionOpening(ExecutionKind.Steps, "coder@1", QUEUED_AT, CLAIMED_AT),
    { kind: "steps", worker_name: "coder@1", queue_wait_ms: 2500 },
  );
  assert.deepEqual(
    executionOpening(ExecutionKind.Evaluation, "judge@2", QUEUED_AT, QUEUED_AT),
    { kind: "evaluation", worker_name: "judge@2", queue_wait_ms: 0 },
  );
});

test("the wait never drops below zero when the clock steps back", () => {
  assert.equal(
    executionOpening(ExecutionKind.Steps, "coder@1", CLAIMED_AT, QUEUED_AT)
      .queue_wait_ms,
    NO_WAIT,
  );
});

test("a root start without a worker name is refused", () => {
  assert.throws(() =>
    executionOpening(ExecutionKind.Steps, "", QUEUED_AT, CLAIMED_AT),
  );
});
