import assert from "node:assert/strict";
import { test } from "node:test";
import { CodedError } from "../kernel/errors.ts";
import {
  type Checks,
  holds,
  type Observation,
  type ReadOperation,
  scoreRun,
} from "./score.ts";

const LIST_CALL = {
  tool_call_id: "call-1",
  name: "project--list",
  arguments: { limit: 10 },
};
const UNBLOCK_CALL = {
  tool_call_id: "call-2",
  name: "mission--node--unblock",
  arguments: { node_id: "node-1" },
};
const OFFER = {
  kind: "action_offer",
  tool_call_id: "call-3",
  operation_id: "project.create",
  target_id: "project-1",
  seen: { version: 1 },
} as const;
const FINAL_STATE = "final_state";
const ANSWER = { name: "alpha", state: "active" };

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    calls: [LIST_CALL],
    results: {},
    reply: "The project alpha is ready.",
    offers: [OFFER],
    usage: { input: 0, output: 0, cost: 0 },
    confirmations: [],
    unexpected_approval: false,
    ...overrides,
  };
}

const read: ReadOperation = async () => ANSWER;

const CONFORMING_CHECKS: Checks = {
  expect_calls: [
    { operation_id: "project.list", input: { limit: 10 }, count: 1 },
    { tool: "project--list" },
  ],
  forbid_calls: [{ operation_id: "mission.node.unblock" }],
  final_state: [
    { operation_id: "project.get", input: {}, expect: { name: "alpha" } },
  ],
  reply_contains: ["PROJECT ALPHA"],
  reply_forbids: ["secret"],
  max_tool_calls: 1,
  max_confirmations: 0,
  expect_offer: { operation_id: "project.create", target_id: "project-1" },
  forbid_offer: [{ operation_id: "project.delete" }],
  max_offers: 1,
};

interface Violation {
  title: string;
  kind: string;
  checks: Checks;
  observed?: Partial<Observation>;
  read?: ReadOperation;
}

const VIOLATIONS: Violation[] = [
  {
    title: "expect_calls with no call",
    kind: "expect_calls",
    checks: { expect_calls: [{ operation_id: "project.list" }] },
    observed: { calls: [] },
  },
  {
    title: "expect_calls with an input subset mismatch",
    kind: "expect_calls",
    checks: {
      expect_calls: [{ operation_id: "project.list", input: { limit: 5 } }],
    },
  },
  {
    title: "expect_calls with two calls for count 1",
    kind: "expect_calls",
    checks: { expect_calls: [{ operation_id: "project.list", count: 1 }] },
    observed: { calls: [LIST_CALL, { ...LIST_CALL, tool_call_id: "call-9" }] },
  },
  {
    title: "forbid_calls with one forbidden call",
    kind: "forbid_calls",
    checks: { forbid_calls: [{ operation_id: "mission.node.unblock" }] },
    observed: { calls: [LIST_CALL, UNBLOCK_CALL] },
  },
  {
    title: "final_state with an answer that does not hold",
    kind: "final_state",
    checks: {
      final_state: [
        { operation_id: "project.get", input: {}, expect: { name: "beta" } },
      ],
    },
  },
  {
    title: "reply_contains with a missing string",
    kind: "reply_contains",
    checks: { reply_contains: ["beta"] },
  },
  {
    title: "reply_forbids with a matching pattern",
    kind: "reply_forbids",
    checks: { reply_forbids: ["(?i:READY)"] },
  },
  {
    title: "max_tool_calls 2 with three calls",
    kind: "max_tool_calls",
    checks: { max_tool_calls: 2 },
    observed: {
      calls: [LIST_CALL, UNBLOCK_CALL, { ...LIST_CALL, tool_call_id: "c-3" }],
    },
  },
  {
    title: "max_confirmations 0 with one answered approval",
    kind: "max_confirmations",
    checks: { max_confirmations: 0 },
    observed: {
      confirmations: [
        { operation_id: "project.create", tool_call_id: "c-4", answer: "yes" },
      ],
    },
  },
  {
    title: "expect_offer with no matching offer",
    kind: "expect_offer",
    checks: {
      expect_offer: { operation_id: "project.create", target_id: "other" },
    },
  },
  {
    title: "forbid_offer with an empty filter and one offer",
    kind: "forbid_offer",
    checks: { forbid_offer: [{}] },
  },
  {
    title: "max_offers 0 with one offer",
    kind: "max_offers",
    checks: { max_offers: 0 },
  },
  {
    title: "unexpected_approval true",
    kind: "unexpected_approval",
    checks: {},
    observed: { unexpected_approval: true },
  },
];

test("invariant guard: verdict - each L2 check kind fails on a violating observation", async () => {
  const conforming = await scoreRun(CONFORMING_CHECKS, observation(), read);
  assert.deepEqual(
    conforming.checks.filter((result) => !result.passed),
    [],
  );
  assert.equal(conforming.passed, true);
  for (const violation of VIOLATIONS) {
    const score = await scoreRun(
      violation.checks,
      observation(violation.observed),
      violation.read ?? read,
    );
    const result = score.checks.find((item) => item.kind === violation.kind);
    assert.equal(score.passed, false, violation.title);
    assert.equal(result?.passed, false, violation.title);
  }
});

test("invariant guard: verdict - deep subset holds arrays only item by item at equal length", () => {
  const a = { id: 1 };
  const b = { id: 2 };
  const c = { id: 3 };
  assert.equal(holds([a, b], [a, b]), true);
  assert.equal(holds([a, b], [a]), false);
  assert.equal(holds([a, b], [a, b, c]), false);
  assert.equal(holds([a, b], [b, a]), false);
  assert.equal(holds([], []), true);
  assert.equal(holds([], [a]), false);
  assert.equal(
    holds([{ id: 1 }, { id: 2 }], [{ id: 1, extra: true }, { id: 2 }]),
    true,
  );
  assert.equal(holds([{ id: 1 }], [{ id: 9, extra: true }]), false);
});

test("invariant guard: data loss - a rejected read fails final_state and scoreRun does not throw", async () => {
  const rejected: ReadOperation = async () => {
    throw new CodedError("mission.node.not_found", "The node is absent.");
  };
  const score = await scoreRun(
    {
      final_state: [
        { operation_id: "mission.node.get", input: {}, expect: {} },
      ],
    },
    observation(),
    rejected,
  );
  const result = score.checks.find((item) => item.kind === FINAL_STATE);
  assert.equal(score.passed, false);
  assert.equal(result?.passed, false);
  assert.match(result?.detail ?? "", /mission\.node\.not_found/);
});
