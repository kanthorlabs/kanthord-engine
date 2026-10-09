import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedVerificationRationale,
  parseJudgement,
  taskJudgementSchema,
  evaluationJudgementSchema,
  evaluationInstruction,
  JUDGEMENT_MARKER,
  repairInstruction,
  taskJudgementInstruction,
} from "./judgement.ts";
import type { Verification } from "./verification.ts";

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
      'kanthord-judgement: {"result":"criterion-not-met","rationale":"task failed"}',
      evaluationJudgementSchema,
    ),
    { result: "criterion-not-met", rationale: "task failed" },
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
