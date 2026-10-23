import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedVerificationRationale,
  failedVerificationReport,
  parseJudgement,
  taskJudgementSchema,
  evaluationJudgementSchema,
  judgementRationale,
  examineInstruction,
  evaluationInstruction,
  JUDGEMENT_MARKER,
  repairInstruction,
  taskRevisionInstruction,
  requestedChangesText,
  REQUESTED_CHANGES_MAX_BYTES,
} from "./judgement.ts";
import { VerificationClass, type Verification } from "./verification.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { PromptTemplate } from "../../agent/contract.ts";

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
      proposals: [],
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
    { result: "success", rationale: "met", unmet: [], proposals: [] },
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
  const input = {
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
  };
  const instruction = evaluationInstruction(SHIPPED_TEMPLATES, input);
  const examineEvaluation = evaluationInstruction(SHIPPED_TEMPLATES, {
    ...input,
    examine: true,
  });
  assert.doesNotMatch(instruction, /proposals/);
  assert.match(
    examineEvaluation,
    /A defect inside a completed implement dependency gets one proposal with dependency_id, name, requirement, criterion and one task, and proposals replace criterion-not-met for such defects\./,
  );
  assert.match(examineEvaluation, /"proposals": \[\{"dependency_id"/);
  assert.match(instruction, /distinct criterion/);
  assert.match(
    instruction,
    /Verification results of this evaluation: \[\{"command":"npm run verify","exit_code":0/,
  );
  assert.match(
    instruction,
    /default-standard violation requires criterion-not-met/,
  );
  assert.match(
    instruction,
    /prose style and the finding format of a produced report are no ground for criterion-not-met/,
  );
  assert.match(instruction, /List every unmet item that you find/);
  assert.doesNotMatch(
    instruction,
    /reasoningEffort|modelIdentifier|resourceBudget/,
  );
});

const JUDGEMENT_REPAIR =
  "The reply holds no valid kanthord-judgement: line. Reply again with exactly one such line.";

test("the repair instruction names the marker of the invalid reply", () => {
  assert.equal(
    repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER),
    JUDGEMENT_REPAIR,
  );
});

test("the task judgement instruction carries no previous judgement", () => {
  assert.doesNotMatch(
    SHIPPED_TEMPLATES[PromptTemplate.TaskJudgement],
    /prior_rationale|Previous judgement/,
  );
});

const EXAMINE_EMPTY = {
  repositories: [],
  verification: null,
  dependencies: [],
  outcomes: [],
  evidence: [],
};

test("the examine instruction makes the reply the report and forbids a file", () => {
  const instruction = examineInstruction(SHIPPED_TEMPLATES, EXAMINE_EMPTY);
  assert.match(instruction, /Your reply is the report/);
  assert.match(instruction, /write no file/);
  assert.match(instruction, /every field including fix: and why:/);
});

test("the examine instruction carries the final-snapshot verification", () => {
  const instruction = examineInstruction(SHIPPED_TEMPLATES, {
    ...EXAMINE_EMPTY,
    verification: {
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
    },
  });
  assert.match(instruction, /Final-snapshot verification: \{"tested_input"/);
  assert.match(instruction, /"commit":"d6d4973"/);
  assert.match(instruction, /"command":"npm run verify","exit_code":0/);
});

test("the task revision carries the output of the failed verification when it has one", () => {
  const verification: Verification = {
    tested_input: { kind: "produced", sha256: "hash" },
    results: [
      { command: "npm test", exit_code: 1, signal: null, timed_out: false },
    ],
  };
  const withOutput = taskRevisionInstruction(
    SHIPPED_TEMPLATES,
    verification,
    ["npm test"],
    "✖ shutdown test timed out",
  );
  assert.match(
    withOutput,
    /Verification 1 `npm test` failed with exit code 1\./,
  );
  assert.match(withOutput, /```text\n✖ shutdown test timed out\n```$/);
  const withoutOutput = taskRevisionInstruction(
    SHIPPED_TEMPLATES,
    verification,
    ["npm test"],
    "",
  );
  assert.doesNotMatch(withoutOutput, /Output of the last verification/);
});

test("a failed verification report names a flaky command and carries its output", () => {
  const run = {
    verification: {
      tested_input: { kind: "produced" as const, sha256: "hash" },
      results: [
        { command: "npm test", exit_code: 1, signal: null, timed_out: false },
      ],
    },
    outputs: ["✖ order is created_at DESC"],
    flaky: [true],
    outcome: VerificationClass.CodeFailure,
  };
  const report = failedVerificationReport(run, ["npm test"]);
  assert.match(report, /^Verification 1 `npm test` failed with exit code 1\./);
  assert.match(
    report,
    /passed on a rerun of the same commit, so the test is flaky/,
  );
  assert.match(report, /```text\n✖ order is created_at DESC\n```$/);
  assert.doesNotMatch(
    failedVerificationReport({ ...run, flaky: [false] }, ["npm test"]),
    /flaky/,
  );
});

test("the requested changes text is null without a change request and stops at 4 KiB", () => {
  const read = (body: string) => ({
    binding: "repo",
    head_commit: "a".repeat(40),
    change_requests: [
      {
        review_id: 1,
        reviewer: "octo",
        body,
        submitted_at: null,
        commit_id: "a".repeat(40),
        comments: [],
      },
    ],
  });
  assert.equal(requestedChangesText([]), null);
  assert.equal(
    requestedChangesText([
      { binding: "repo", head_commit: "a".repeat(40), change_requests: [] },
    ]),
    null,
  );
  const long = requestedChangesText([
    read("x".repeat(REQUESTED_CHANGES_MAX_BYTES)),
  ]);
  assert.ok(long);
  assert.ok(
    long.startsWith("The pull request reviewers request these changes:"),
  );
  assert.ok(
    long.endsWith("[The requested changes exceed 4 KiB and end here.]"),
  );
  assert.equal(
    Buffer.byteLength(long.slice(0, long.lastIndexOf("\n")), "utf8"),
    REQUESTED_CHANGES_MAX_BYTES,
  );
});

test("each change request names its binding", () => {
  const request = (reviewer: string, commit: string) => ({
    review_id: 1,
    reviewer,
    body: `${reviewer} body`,
    submitted_at: null,
    commit_id: commit,
    comments: [],
  });
  assert.equal(
    requestedChangesText([
      {
        binding: "api",
        head_commit: "a".repeat(40),
        change_requests: [request("octo", "a".repeat(40))],
      },
      {
        binding: "web",
        head_commit: "b".repeat(40),
        change_requests: [request("hubot", "b".repeat(40))],
      },
    ]),
    [
      "The pull request reviewers request these changes:",
      `Reviewer octo requests changes on api at commit ${"a".repeat(40)}: octo body`,
      `Reviewer hubot requests changes on web at commit ${"b".repeat(40)}: hubot body`,
    ].join("\n"),
  );
});
