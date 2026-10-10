import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedVerificationRationale,
  parseJudgement,
  taskJudgementSchema,
  evaluationJudgementSchema,
  judgementRationale,
  reportInstruction,
  evaluationInstruction,
  JUDGEMENT_MARKER,
  repairInstruction,
  taskJudgementInstruction,
} from "./judgement.ts";
import type { Verification } from "./verification.ts";

const TWO_GAP_RATIONALE =
  "two gaps\nUnmet:\n- task_a: no route check\n- task_b: no restart test";

test("the final marker is strict and invalid handoffs are refused", () => {
  const text =
    'kanthord-judgement: {"criterion_met":false,"rationale":"before"}\nkanthord-judgement: {"criterion_met":true,"rationale":" final "}';
  assert.deepEqual(parseJudgement(text, taskJudgementSchema), {
    criterion_met: true,
    rationale: "final",
  });
  for (const invalid of [
    undefined,
    "missing",
    "kanthord-judgement: invalid",
    'kanthord-judgement: {"criterion_met":true,"rationale":" "}',
    'kanthord-judgement: {"criterion_met":true,"rationale":"yes","extra":true}',
  ])
    assert.equal(parseJudgement(invalid, taskJudgementSchema), null);
  assert.deepEqual(
    parseJudgement(
      'kanthord-judgement: {"result":"criterion-not-met","rationale":"task failed","unmet":[{"id":"task","reason":"no test"}]}',
      evaluationJudgementSchema,
    ),
    {
      result: "criterion-not-met",
      rationale: "task failed",
      unmet: [{ id: "task", reason: "no test" }],
    },
  );
  assert.equal(
    parseJudgement(
      'kanthord-judgement: {"result":"criterion-not-met","rationale":"task failed"}',
      evaluationJudgementSchema,
    ),
    null,
  );
  assert.deepEqual(
    parseJudgement(
      'kanthord-judgement: {"result":"success","rationale":"met"}',
      evaluationJudgementSchema,
    ),
    { result: "success", rationale: "met", unmet: [] },
  );
  assert.equal(
    judgementRationale({
      rationale: "two gaps",
      unmet: [
        { id: "task_a", reason: "no route check" },
        { id: "task_b", reason: "no restart test" },
      ],
    }),
    TWO_GAP_RATIONALE,
  );
});

test("failed and unrun rationale names the command and cause", () => {
  const testedInput = { kind: "produced" as const, sha256: "a".repeat(64) };
  const cases: [Verification["results"], string][] = [
    [[], "was not run."],
    [
      [{ command: "check", exit_code: 2, signal: null, timed_out: false }],
      "failed with exit code 2.",
    ],
    [
      [
        {
          command: "check",
          exit_code: null,
          signal: "SIGKILL",
          timed_out: false,
        },
      ],
      "was ended by signal SIGKILL.",
    ],
    [
      [
        {
          command: "check",
          exit_code: null,
          signal: "SIGKILL",
          timed_out: true,
        },
      ],
      "reached its deadline.",
    ],
  ];
  for (const [results, cause] of cases)
    assert.equal(
      failedVerificationRationale({ tested_input: testedInput, results }, [
        "check",
      ]),
      `Verification 1 \`check\` ${cause}`,
    );
  const instruction = evaluationInstruction({
    tasks: [
      {
        id: "task",
        filename: "task.md",
        content: {
          name: "task",
          requirement: "do",
          criterion: "distinct criterion",
          verifications: [],
          bindings: [],
        },
      },
    ],
    verification: {
      tested_input: testedInput,
      results: [
        {
          command: "npm run verify",
          exit_code: 0,
          signal: null,
          timed_out: false,
        },
      ],
    },
    evidence: [],
  });
  assert.match(instruction, /distinct criterion/);
  assert.match(
    instruction,
    /Verification results of this evaluation: \[\{"command":"npm run verify","exit_code":0/,
  );
  assert.match(
    instruction,
    /default-standard violation requires criterion-not-met/,
  );
  assert.doesNotMatch(
    instruction,
    /reasoningEffort|modelIdentifier|resourceBudget/,
  );
});

const JUDGEMENT_REPAIR =
  "The reply holds no valid kanthord-judgement: line. Reply again with exactly one such line.";

test("the repair instruction names the marker of the invalid reply", () => {
  assert.equal(repairInstruction(JUDGEMENT_MARKER), JUDGEMENT_REPAIR);
});

test("a prior rationale adds the previous judgement to the task judgement instruction", () => {
  const task = {
    id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    filename: "task.md",
    content: {
      name: "task",
      requirement: "work",
      criterion: "criterion",
      verifications: ["true"],
      bindings: [],
    },
  };
  const plain = taskJudgementInstruction(task);
  assert.equal(taskJudgementInstruction(task, null), plain);
  assert.doesNotMatch(plain, /Previous judgement/);
  assert.equal(
    taskJudgementInstruction(task, "edge case unmet"),
    plain.replace(
      "\nEnd with exactly:",
      "\nPrevious judgement: edge case unmet. Judge whether the task criterion is met now.\nEnd with exactly:",
    ),
  );
});

test("the report instruction makes the reply the report and forbids a file", () => {
  const instruction = reportInstruction([], [], [], null);
  assert.match(instruction, /Your reply is the report/);
  assert.match(instruction, /write no file/);
  assert.match(instruction, /every field including fix: and why:/);
});

test("the report instruction carries the final-snapshot verification", () => {
  const instruction = reportInstruction([], [], [], {
    tested_input: [
      { kind: "repository", binding_id: "binding", commit: "d6d4973" },
    ],
    results: [
      {
        command: "npm run verify",
        exit_code: 0,
        signal: null,
        timed_out: false,
      },
    ],
  });
  assert.match(instruction, /Final-snapshot verification: \{"tested_input"/);
  assert.match(instruction, /"commit":"d6d4973"/);
  assert.match(instruction, /"command":"npm run verify","exit_code":0/);
});
