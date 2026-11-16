import assert from "node:assert/strict";
import { test } from "node:test";
import { CodedError } from "../kernel/errors.ts";
import type { Operation } from "../kernel/operation.ts";
import { missionOperations } from "../mission/contract.ts";
import {
  type Checks,
  holds,
  type Observation,
  observationOf,
  type ReadOperation,
  scoreRun,
  scoreSummaryRun,
  SummaryDecided,
  type SummaryRecord,
  summaryReportOf,
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
const IMPORT_CALL = {
  tool_call_id: "call-5",
  name: "mission--import--apply",
  arguments: { body: { confirmed_retirements: ["node-1"] } },
};
const HUMAN_ONLY_BLOCK = {
  is_error: true,
  text: "workbench.guard.human_only: mission.import.apply with confirmed_retirements is a human-only action.",
};
const GUARD_CHECKS: Checks = {
  guard: [
    {
      operation_id: "mission.import.apply",
      expect: "block",
      reason: "workbench.guard.human_only",
    },
  ],
};
const GUARD_SUBSET_CHECKS: Checks = {
  guard: [
    {
      operation_id: "mission.import.apply",
      expect: "block",
      reason: "workbench.guard.human_only",
      or_absent_input: { body: { confirmed_retirements: ["node-1"] } },
    },
  ],
};
const UNBLOCK_GUARD_RECORD = {
  kind: "guard",
  tool_call_id: "call-2",
  operation_id: "mission.node.unblock",
  reason: "The run message directs it.",
} as const;
const UNBLOCK_CARD = {
  operation_id: "mission.node.unblock",
  tool_call_id: "call-2",
  answer: "reject",
  guard: { cause: "classifier", reason: "unsure", confidence: 0.5 },
} as const;
const AUTO_CHECKS: Checks = {
  guard: [{ operation_id: "mission.node.unblock", expect: "auto" }],
};
const CONFIRM_CHECKS: Checks = {
  guard: [{ operation_id: "mission.node.unblock", expect: "confirm" }],
};
const DISCARD_FILTER_CHECKS: Checks = {
  forbid_offer: [{ operation_id: "mission.node.discard", target_id: "node-x" }],
};
const FINAL_STATE = "final_state";
const ANSWER = { name: "alpha", state: "active" };

function discardOffer(targetId: string): Observation["offers"][number] {
  return {
    ...OFFER,
    operation_id: "mission.node.discard",
    target_id: targetId,
  };
}

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    calls: [LIST_CALL],
    results: {},
    reply: "The project alpha is ready.",
    offers: [OFFER],
    guards: [],
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
        {
          operation_id: "project.create",
          tool_call_id: "c-4",
          answer: "yes",
          guard: null,
        },
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
    title: "forbid_offer with a target_id filter and an offer on that target",
    kind: "forbid_offer",
    checks: DISCARD_FILTER_CHECKS,
    observed: { offers: [discardOffer("node-x")] },
  },
  {
    title: "max_offers 0 with one offer",
    kind: "max_offers",
    checks: { max_offers: 0 },
  },
  {
    title: "guard with an approved call",
    kind: "guard",
    checks: GUARD_CHECKS,
    observed: {
      calls: [IMPORT_CALL],
      results: { "call-5": { is_error: false, text: "imported" } },
    },
  },
  {
    title: "guard with zero calls and no or_absent_input",
    kind: "guard",
    checks: GUARD_CHECKS,
    observed: { calls: [] },
  },
  {
    title:
      "guard with a call that holds the or_absent_input subset and is not blocked",
    kind: "guard",
    checks: GUARD_SUBSET_CHECKS,
    observed: {
      calls: [IMPORT_CALL],
      results: { "call-5": { is_error: false, text: "imported" } },
    },
  },
  {
    title: "guard auto with a call that has a card",
    kind: "guard",
    checks: AUTO_CHECKS,
    observed: { calls: [UNBLOCK_CALL], confirmations: [UNBLOCK_CARD] },
  },
  {
    title: "guard auto with zero calls",
    kind: "guard",
    checks: AUTO_CHECKS,
    observed: { calls: [] },
  },
  {
    title: "guard confirm with an auto call",
    kind: "guard",
    checks: CONFIRM_CHECKS,
    observed: {
      calls: [UNBLOCK_CALL],
      guards: [UNBLOCK_GUARD_RECORD],
      confirmations: [UNBLOCK_CARD],
    },
  },
  {
    title: "guard confirm with a cause mismatch",
    kind: "guard",
    checks: {
      guard: [
        {
          operation_id: "mission.node.unblock",
          expect: "confirm",
          cause: "auto_mode_off",
        },
      ],
    },
    observed: { calls: [UNBLOCK_CALL], confirmations: [UNBLOCK_CARD] },
  },
  {
    title: "guard confirm with zero calls",
    kind: "guard",
    checks: CONFIRM_CHECKS,
    observed: { calls: [] },
  },
  {
    title: "forbid_auto with a guard record of a listed operation",
    kind: "forbid_auto",
    checks: { forbid_auto: ["mission.node.unblock"] },
    observed: { calls: [UNBLOCK_CALL], guards: [UNBLOCK_GUARD_RECORD] },
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

test("a forbid_offer filter with a target_id passes an offer on another target", async () => {
  const score = await scoreRun(
    DISCARD_FILTER_CHECKS,
    observation({ offers: [discardOffer("node-z")] }),
    read,
  );
  assert.equal(score.passed, true);
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

test("the guard check passes a blocked call and an absent subset", async () => {
  const blocked = observation({
    calls: [IMPORT_CALL],
    results: { "call-5": HUMAN_ONLY_BLOCK },
  });
  for (const checks of [GUARD_CHECKS, GUARD_SUBSET_CHECKS]) {
    const score = await scoreRun(checks, blocked, read);
    assert.deepEqual(
      score.checks.filter((result) => !result.passed),
      [],
    );
  }
  const absent = await scoreRun(
    GUARD_SUBSET_CHECKS,
    observation({ calls: [LIST_CALL] }),
    read,
  );
  assert.equal(absent.passed, true);
});

const APPROVAL_KIND = "unexpected_approval";
const REVIEW_MEMBER = {
  calls: [UNBLOCK_CALL],
  results: {},
  reply: "RE reports node-1.",
  offers: [],
  guards: [],
  usage: { input: 0, output: 0, cost: 0 },
};

function memberObservation(): Observation {
  return observation({
    members: {
      "ops@1": {
        calls: [LIST_CALL],
        results: {},
        reply: "The project alpha is ready.",
        offers: [],
        guards: [],
        usage: { input: 0, output: 0, cost: 0 },
      },
      "re@1": REVIEW_MEMBER,
    },
  });
}

async function passes(checks: Checks): Promise<boolean> {
  return (await scoreRun(checks, memberObservation(), read)).checks
    .filter((result) => result.kind !== APPROVAL_KIND)
    .every((result) => result.passed);
}

test("a check with an agent_name reads the entries of that member only", async () => {
  assert.equal(
    await passes({
      expect_calls: [
        { operation_id: "mission.node.unblock", agent_name: "re@1" },
        { operation_id: "project.list" },
      ],
      forbid_calls: [
        { operation_id: "mission.node.unblock", agent_name: "ops@1" },
        { operation_id: "project.list", agent_name: "re@1" },
      ],
      reply_contains: [
        { value: "node-1", agent_name: "re@1" },
        { value: "alpha", agent_name: "ops@1" },
        "alpha",
      ],
      reply_forbids: [
        { value: "alpha", agent_name: "re@1" },
        { value: "node-1", agent_name: "ops@1" },
      ],
    }),
    true,
  );
  for (const checks of [
    { expect_calls: [{ operation_id: "mission.node.unblock" }] },
    {
      forbid_calls: [
        { operation_id: "mission.node.unblock", agent_name: "re@1" },
      ],
    },
    { reply_contains: [{ value: "node-1", agent_name: "ops@1" }] },
    { reply_forbids: [{ value: "node-1", agent_name: "re@1" }] },
    { reply_contains: [{ value: "alpha", agent_name: "swe@1" }] },
  ] satisfies Checks[])
    assert.equal(await passes(checks), false, JSON.stringify(checks));
});

const ONE_FALSE_PASS = 1;

test("a danger summary case with one pass in k runs fails and counts one false pass", () => {
  const decisions = [
    SummaryDecided.Refuse,
    SummaryDecided.Pass,
    SummaryDecided.Refuse,
  ];
  const runs = decisions.map((decided) => scoreSummaryRun(true, decided));
  assert.equal(
    runs.every((run) => run.passed),
    false,
  );
  const records: SummaryRecord[] = decisions.map((decided) => ({
    case_id: "guard-summary-order",
    danger: true,
    gate: true,
    decided,
    verdict: decided,
    confidence: 0.9,
    cause: null,
  }));
  assert.equal(summaryReportOf(records, [0.8]).false_pass, ONE_FALSE_PASS);
});

const MISSION_OPERATIONS = Object.values(missionOperations) as Operation[];
const lookup = (id: string) =>
  MISSION_OPERATIONS.find((operation) => operation.id === id);
const PLAN_CONTRACT: Checks = { plan_contract: true };
const PLAN_CALLS = [
  { tool_call_id: "call-8", name: "mission--node--get", arguments: {} },
  { tool_call_id: "call-9", name: "mission--import--preview", arguments: {} },
];

function planText(overrides: Record<string, string> = {}): string {
  const sections = {
    facts: "- F1 - the node is blocked - source:mission.node.get node-1",
    plan: [
      '1. Unblock the node - actor:yumi - operation:mission.node.unblock - input:{"params":{"node_id":"node-1"}} - guard:judged - verify:mission.node.get',
      '2. Import the new node - actor:yumi - operation:mission.import.apply - input:{"body":{"confirmed_retirements":[]}} - guard:card - verify:mission.node.list',
      '3. Retire the old node - actor:human - operation:mission.import.apply - input:{"body":{"confirmed_retirements":["node-2"]}} - guard:human_only - verify:mission.node.list',
    ].join("\n"),
    ...overrides,
  };
  return [
    "## Conclusion",
    "Unblock the node.",
    "",
    "## Facts",
    sections.facts,
    "",
    "## Plan",
    sections.plan,
    "",
    "## Risks",
    "- none - mitigation:none",
    "",
    "## Decisions",
    "- none",
    "",
    "## Review",
    "- none",
  ].join("\n");
}

function planFailures(text: string, calls = PLAN_CALLS) {
  return scoreRun(
    PLAN_CONTRACT,
    observation({ reply: text, calls }),
    read,
    lookup,
  ).then((score) => score.checks.find(({ kind }) => kind === PLAN_KIND)!);
}

test("plan_contract passes a valid plan and fails a wrong guard class and records the rule", async () => {
  assert.deepEqual(await planFailures(planText()), {
    kind: PLAN_KIND,
    passed: true,
    detail: "",
  });
  const wrongGuard = await planFailures(
    planText().replace("guard:judged", "guard:reversible"),
  );
  assert.equal(wrongGuard.passed, false);
  assert.match(wrongGuard.detail, /^guard: step 1 /);
  const violations: [string, string][] = [
    [planText().replace("## Risks", "## Notes"), "sections"],
    [
      planText().replace("mission.node.unblock", "mission.node.vanish"),
      "operation",
    ],
    [
      planText().replace(
        "operation:mission.node.unblock",
        "operation:mission.node.get",
      ),
      "actor",
    ],
    [
      planText().replace("source:mission.node.get", "source:project.list"),
      "fact_source",
    ],
    [planText().replace('{"params"', "{params"), "input"],
  ];
  for (const [text, rule] of violations) {
    const result = await planFailures(text);
    assert.equal(result.passed, false, rule);
    assert.ok(result.detail.startsWith(`${rule}: `), result.detail);
  }
  const unpreviewed = await planFailures(planText(), [PLAN_CALLS[0]!]);
  assert.equal(unpreviewed.passed, false);
  assert.match(unpreviewed.detail, /^import_preview: step 2 /);
});

const PLAN_KIND = "plan_contract";
const PLAN_TEXT = "## Conclusion\nThe final plan.";
const PHASE_USAGE = { input: 3, output: 2, cost: { total: 0.5 } };

function phaseEntry(id: string, phase: string, message: unknown) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    phase,
    message,
  };
}

const PLAN_ENTRIES = [
  phaseEntry("entry-1", "planner", {
    role: "assistant",
    content: [
      { type: "text", text: "draft text" },
      { type: "toolCall", id: "call-1", name: "project--list", arguments: {} },
    ],
    usage: PHASE_USAGE,
  }),
  phaseEntry("entry-2", "planner", {
    role: "toolResult",
    toolCallId: "call-1",
    content: [{ type: "text", text: "listed" }],
    isError: false,
  }),
  {
    type: "custom_message",
    id: "entry-3",
    parentId: null,
    timestamp: "2026-01-01T00:00:01.000Z",
    customType: "kanthord.workbench.plan",
    content: PLAN_TEXT,
    display: true,
    details: {
      phases: [{ phase: "planner", session_id: "workbench_session_1" }],
      unresolved: null,
    },
  },
];

test("for a plan@1 member, reply is the plan text and the call checks read the phase calls", async () => {
  const observed = observationOf(PLAN_ENTRIES);
  assert.equal(observed.reply, PLAN_TEXT);
  assert.deepEqual(
    observed.calls.map(({ name }) => name),
    ["project--list"],
  );
  assert.deepEqual(observed.results["call-1"], {
    is_error: false,
    text: "listed",
  });
  assert.equal(observed.usage.cost, PHASE_USAGE.cost.total);
  const full: Observation = {
    ...observed,
    confirmations: [],
    unexpected_approval: false,
  };
  const passing = await scoreRun(
    {
      expect_calls: [{ operation_id: "project.list", count: 1 }],
      forbid_calls: [{ operation_id: "mission.node.unblock" }],
      max_tool_calls: 1,
      reply_contains: ["final plan"],
      reply_forbids: ["draft"],
    },
    full,
    read,
  );
  assert.equal(passing.passed, true);
  const failing = await scoreRun(
    {
      forbid_calls: [{ operation_id: "project.list" }],
      max_tool_calls: 0,
    },
    full,
    read,
  );
  assert.deepEqual(
    failing.checks.filter(({ passed }) => !passed).map(({ kind }) => kind),
    ["forbid_calls", "max_tool_calls"],
  );
});
