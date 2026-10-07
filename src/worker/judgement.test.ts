import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedVerificationRationale,
  parseJudgement,
  taskJudgementSchema,
  evaluationJudgementSchema,
  evaluationInstruction,
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
      [{ command: "check", exitCode: 2, signal: null, timedOut: false }],
      "failed with exit code 2.",
    ],
    [
      [
        {
          command: "check",
          exitCode: null,
          signal: "SIGKILL",
          timedOut: false,
        },
      ],
      "was ended by signal SIGKILL.",
    ],
    [
      [{ command: "check", exitCode: null, signal: "SIGKILL", timedOut: true }],
      "reached its deadline.",
    ],
  ];
  for (const [results, cause] of cases)
    assert.equal(
      failedVerificationRationale({ testedInput, results }, ["check"]),
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
    testedInput,
    evidence: [],
  });
  assert.match(instruction, /distinct criterion/);
  assert.match(
    instruction,
    /default-standard violation requires criterion-not-met/,
  );
  assert.doesNotMatch(
    instruction,
    /reasoningEffort|modelIdentifier|resourceBudget/,
  );
});
