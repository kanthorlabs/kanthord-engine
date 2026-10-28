import assert from "node:assert/strict";
import { test } from "node:test";
import { ExecutionKind } from "../tracking/contract.ts";
import { executionOpening, executionTransition } from "./telemetry.ts";
import { transitionFixture } from "./test-support.ts";

const QUEUED_AT = 10000;
const CLAIMED_AT = 12500;
const HELD_FAILURES = 2;
const HELD_UNTIL = 72500;
const NO_WAIT = 0;
const NO_FACTS = {
  worker_instance: null,
  placement: null,
  revision_turn: null,
  dependency_count: null,
  node_name: null,
};

test("the root start facts hold the kind, the worker name and the wait", () => {
  assert.deepEqual(
    executionOpening(
      ExecutionKind.Steps,
      "coder@1",
      QUEUED_AT,
      CLAIMED_AT,
      NO_FACTS,
    ),
    {
      kind: "steps",
      worker_name: "coder@1",
      queue_wait_ms: 2500,
      worker_instance: null,
      placement: null,
      revision_turn: null,
      dependency_count: null,
      node_name: null,
    },
  );
  assert.deepEqual(
    executionOpening(
      ExecutionKind.Evaluation,
      "judge@2",
      QUEUED_AT,
      QUEUED_AT,
      NO_FACTS,
    ),
    {
      kind: "evaluation",
      worker_name: "judge@2",
      queue_wait_ms: 0,
      worker_instance: null,
      placement: null,
      revision_turn: null,
      dependency_count: null,
      node_name: null,
    },
  );
});

test("the root start copies the facts", () => {
  const facts = {
    worker_instance: "coder",
    placement: "container",
    revision_turn: true,
    dependency_count: 2,
    node_name: "Write the report",
  };
  assert.deepEqual(
    executionOpening(
      ExecutionKind.Steps,
      "coder@1",
      QUEUED_AT,
      CLAIMED_AT,
      facts,
    ),
    { kind: "steps", worker_name: "coder@1", queue_wait_ms: 2500, ...facts },
  );
});

test("the wait never drops below zero when the clock steps back", () => {
  assert.equal(
    executionOpening(
      ExecutionKind.Steps,
      "coder@1",
      CLAIMED_AT,
      QUEUED_AT,
      NO_FACTS,
    ).queue_wait_ms,
    NO_WAIT,
  );
});

test("a root start without a worker name is refused", () => {
  assert.throws(() =>
    executionOpening(ExecutionKind.Steps, "", QUEUED_AT, CLAIMED_AT, NO_FACTS),
  );
});

test("a transition to Completed with a first available time answers the lead time", () => {
  const transition = transitionFixture({
    to: "Completed",
    first_available_at: QUEUED_AT,
  });
  assert.deepEqual(executionTransition(transition, CLAIMED_AT, null), {
    transitioned_at: CLAIMED_AT,
    from: transition.from,
    to: "Completed",
    rule: transition.rule,
    count: null,
    limit: null,
    lead_time_ms: 2500,
    failure_count: null,
    available_at: null,
  });
});

test("a transition with a failure hold answers its failure count and its hold end", () => {
  const hold = { failure_count: HELD_FAILURES, available_at: HELD_UNTIL };
  const answered = executionTransition(transitionFixture(), CLAIMED_AT, hold);
  assert.equal(answered.failure_count, HELD_FAILURES);
  assert.equal(answered.available_at, HELD_UNTIL);
});

test("a transition to another state or with no first available time answers no lead time", () => {
  assert.equal(
    executionTransition(
      transitionFixture({ to: "Available", first_available_at: QUEUED_AT }),
      CLAIMED_AT,
      null,
    ).lead_time_ms,
    null,
  );
  assert.equal(
    executionTransition(
      transitionFixture({ to: "Completed", first_available_at: null }),
      CLAIMED_AT,
      null,
    ).lead_time_ms,
    null,
  );
});

test("a lead time below zero is refused", () => {
  assert.throws(() =>
    executionTransition(
      transitionFixture({ to: "Completed", first_available_at: CLAIMED_AT }),
      QUEUED_AT,
      null,
    ),
  );
});
