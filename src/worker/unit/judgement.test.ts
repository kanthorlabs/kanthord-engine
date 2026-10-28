import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedFailureReport,
  affectedRevisionInstruction,
  evaluationInstruction,
  evaluationJudgementSchema,
  examineInstruction,
  failedChecksText,
  failedVerificationRationale,
  failedVerificationReport,
  JUDGEMENT_MARKER,
  judgementRationale,
  parseJudgement,
  parseRepaired,
  releaseRevisionInstruction,
  repairInstruction,
  ReplyRepair,
  REQUESTED_CHANGES_MAX_BYTES,
  requestedChangesText,
  taskRevisionInstruction,
  UnmetGround,
  unmetGroundSchema,
} from "./judgement.ts";
import {
  affectedFailureText,
  type AffectedRun,
  AffectedVerdict,
} from "./affected.ts";
import { type Verification, VerificationClass } from "./verification.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import type { NativeAgent } from "./native-agent.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";

const PLAN_DEFECT_RATIONALE =
  'plan defects\nPlan conflict:\n- node: "edit a.ts" vs "a.ts stays unchanged"\nPlan gap:\n- task_b: no test asked\nUnmet:\n- task_a: no route check\n- task_c: no lint';
const PLAN_GAP_RATIONALE = "one gap\nPlan gap:\n- task_b: no test asked";
const MET_RATIONALE = "met";
const SINGLE_CONFLICT_DEFINITION = 1;
const TWO_GAP_RATIONALE =
  "two gaps\nUnmet:\n- task_a: no route check\n- task_b: no restart test";

test("the final marker is strict and invalid handoffs are refused", () => {
  const text =
    'kanthord-judgement: {"result":"undetermined","rationale":"before"}\nkanthord-judgement: {"result":"success","rationale":" final "}';
  assert.deepEqual(parseJudgement(text, evaluationJudgementSchema), {
    result: "success",
    rationale: "final",
    unmet: [],
    proposals: [],
  });
  for (const invalid of [
    undefined,
    "missing",
    "kanthord-judgement: invalid",
    'kanthord-judgement: {"result":"success","rationale":" "}',
    'kanthord-judgement: {"result":"success","rationale":"yes","extra":true}',
  ])
    assert.equal(parseJudgement(invalid, evaluationJudgementSchema), null);
  assert.deepEqual(
    parseJudgement(
      'kanthord-judgement: {"result":"criterion-not-met","rationale":"task failed","unmet":[{"id":"task","reason":"no test","ground":"stated"}]}',
      evaluationJudgementSchema,
    ),
    {
      result: "criterion-not-met",
      rationale: "task failed",
      unmet: [{ id: "task", reason: "no test", ground: "stated" }],
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
        { id: "task_a", reason: "no route check", ground: UnmetGround.Stated },
        {
          id: "task_b",
          reason: "no restart test",
          ground: UnmetGround.Standard,
        },
      ],
    }),
    TWO_GAP_RATIONALE,
  );
});

test("the rationale writes plan conflict and plan gap blocks before the unmet block", () => {
  assert.equal(
    judgementRationale({
      rationale: "plan defects",
      unmet: [
        { id: "task_a", reason: "no route check", ground: UnmetGround.Stated },
        { id: "task_b", reason: "no test asked", ground: UnmetGround.Unstated },
        {
          id: "node",
          reason: '"edit a.ts" vs "a.ts stays unchanged"',
          ground: UnmetGround.Conflict,
        },
        { id: "task_c", reason: "no lint", ground: UnmetGround.Standard },
      ],
    }),
    PLAN_DEFECT_RATIONALE,
  );
  assert.equal(
    judgementRationale({
      rationale: "one gap",
      unmet: [
        { id: "task_b", reason: "no test asked", ground: UnmetGround.Unstated },
      ],
    }),
    PLAN_GAP_RATIONALE,
  );
  assert.equal(
    judgementRationale({ rationale: MET_RATIONALE, unmet: [] }),
    MET_RATIONALE,
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
    affected: null,
  };
  const instruction = evaluationInstruction(SHIPPED_TEMPLATES, input);
  const examineEvaluation = evaluationInstruction(SHIPPED_TEMPLATES, {
    ...input,
    examine: true,
  });
  assert.match(
    instruction,
    /^Affected test results of this evaluation: null$/m,
  );
  const document = { version: 1, verdict: "passed", repositories: [] };
  assert.ok(
    evaluationInstruction(SHIPPED_TEMPLATES, {
      ...input,
      affected: document,
    }).includes(
      `Affected test results of this evaluation: ${JSON.stringify(document)}\n`,
    ),
  );
  assert.match(
    instruction,
    /KanthorD ran the affected test command of each repository after the verifications; weigh a `base_red` verdict, each flaky test and each excluded e2e test as facts about the change\. A change to a file that selects or runs tests is a test change; judge it against the criterion\./,
  );
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
  assert.doesNotMatch(instruction, /prose style/);
  assert.match(instruction, /List every unmet item that you find/);
  assert.match(
    instruction,
    /Give each unmet item a ground: stated for a requirement or criterion of the work prompt, standard for a default-standard rule, unstated for a defect that neither states, conflict for two stated requirements or criteria that the work cannot meet together\./,
  );
  assert.match(
    instruction,
    /conflict for two stated requirements or criteria that the work cannot meet together\. For example, a criterion needs a change to a file that the requirement forbids\. For a conflict, write the reason as the two requirements in quotes, joined by " vs ": "requirement A" vs "requirement B"\. Write every reason in full/,
  );
  assert.match(
    instruction,
    /A changed file that the requirement forbids and that no criterion needs is an unmet stated item\./,
  );
  assert.equal(
    instruction.match(/ground conflict|conflict for/g)?.length,
    SINGLE_CONFLICT_DEFINITION,
  );
  assert.match(instruction, /"ground": "stated"/);
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

const PRODUCED_DIGEST = "hash";
const RELEASE_COMMAND = "npm test";
const FAILED_EXIT = 1;
const NO_OUTPUT = "";
const RELEASE_CLONE = /The release clone holds only tracked files/;

test("only the release revision names the content of the release clone", () => {
  const verification: Verification = {
    tested_input: { kind: "produced", sha256: PRODUCED_DIGEST },
    results: [
      {
        command: RELEASE_COMMAND,
        exit_code: FAILED_EXIT,
        signal: null,
        timed_out: false,
      },
    ],
  };
  assert.match(
    releaseRevisionInstruction(
      SHIPPED_TEMPLATES,
      verification,
      [RELEASE_COMMAND],
      NO_OUTPUT,
    ),
    RELEASE_CLONE,
  );
  assert.doesNotMatch(
    taskRevisionInstruction(
      SHIPPED_TEMPLATES,
      verification,
      [RELEASE_COMMAND],
      NO_OUTPUT,
    ),
    RELEASE_CLONE,
  );
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

test("the failed checks text names each check, binding and commit and stops at 4 KiB", () => {
  const read = (binding: string, commit: string, failed: string[]) => ({
    evidence_id: "evidence",
    binding_id: `binding_${binding}`,
    binding,
    head_commit: commit,
    failed,
  });
  assert.equal(failedChecksText([]), null);
  assert.equal(
    failedChecksText([
      read("api", "a".repeat(40), ["lint", "unit"]),
      read("web", "b".repeat(40), ["build"]),
    ]),
    [
      "The pull request cannot merge:",
      `The required checks lint, unit failed on api at commit ${"a".repeat(40)}.`,
      `The required checks build failed on web at commit ${"b".repeat(40)}.`,
    ].join("\n"),
  );
  const long = failedChecksText([
    read("api", "a".repeat(40), ["x".repeat(REQUESTED_CHANGES_MAX_BYTES)]),
  ]);
  assert.ok(long);
  assert.ok(long.startsWith("The pull request cannot merge:"));
  assert.ok(long.endsWith("[The failed checks exceed 4 KiB and end here.]"));
  assert.equal(
    Buffer.byteLength(long.slice(0, long.lastIndexOf("\n")), "utf8"),
    REQUESTED_CHANGES_MAX_BYTES,
  );
});

const SINGLE_REPAIR = 1;
const GROUNDED_REPLY =
  'kanthord-judgement: {"result":"criterion-not-met","rationale":"r","unmet":[{"id":"task","reason":"no test","ground":"unstated"}]}';
const UNGROUNDED_REPLY =
  'kanthord-judgement: {"result":"criterion-not-met","rationale":"r","unmet":[{"id":"task","reason":"no test"}]}';

test("an unmet item requires a ground of the closed set", () => {
  assert.deepEqual(Object.values(UnmetGround), [
    "stated",
    "standard",
    "unstated",
    "conflict",
  ]);
  assert.equal(unmetGroundSchema.safeParse("other").success, false);
  assert.equal(
    parseJudgement(UNGROUNDED_REPLY, evaluationJudgementSchema),
    null,
  );
  assert.equal(
    parseJudgement(
      GROUNDED_REPLY.replace("unstated", "other"),
      evaluationJudgementSchema,
    ),
    null,
  );
  assert.equal(
    parseJudgement(GROUNDED_REPLY, evaluationJudgementSchema)?.unmet[0]?.ground,
    UnmetGround.Unstated,
  );
});

function repairAgent(replies: readonly (string | undefined)[]) {
  const instructions: string[] = [];
  const templates: PromptTemplate[] = [];
  const agent = {
    budget: { exhausted: () => false },
    instruct: async (
      _work: unknown,
      instruction: string,
      template: PromptTemplate,
    ) => {
      instructions.push(instruction);
      templates.push(template);
    },
    lastText: () => replies[Math.max(instructions.length, 0)],
  };
  return { agent: agent as unknown as NativeAgent, instructions, templates };
}

test("parseRepaired marks a reply that the repair turn produced", async () => {
  const work = {} as WorkPrompt;
  const valid = repairAgent([GROUNDED_REPLY]);
  const first = await parseRepaired(
    SHIPPED_TEMPLATES,
    valid.agent,
    work,
    evaluationJudgementSchema,
  );
  assert.equal(first.repaired, false);
  assert.notEqual(first.reply, ReplyRepair.Invalid);
  assert.deepEqual(valid.instructions, []);
  const repaired = repairAgent([UNGROUNDED_REPLY, GROUNDED_REPLY]);
  const second = await parseRepaired(
    SHIPPED_TEMPLATES,
    repaired.agent,
    work,
    evaluationJudgementSchema,
  );
  assert.equal(second.repaired, true);
  assert.equal(repaired.instructions.length, SINGLE_REPAIR);
  assert.deepEqual(repaired.templates, [PromptTemplate.Repair]);
  assert.equal(
    (second.reply as { unmet: { ground: string }[] }).unmet.at(0)?.ground,
    UnmetGround.Unstated,
  );
  const invalid = repairAgent([UNGROUNDED_REPLY, UNGROUNDED_REPLY]);
  assert.deepEqual(
    await parseRepaired(
      SHIPPED_TEMPLATES,
      invalid.agent,
      work,
      evaluationJudgementSchema,
    ),
    { reply: ReplyRepair.Invalid, repaired: true },
  );
});

function failedRun(repository: string, output: string): AffectedRun {
  const failed = [{ file: `${repository}.test.ts`, name: "one" }];
  const command = `test ${repository}`;
  return {
    verdict: AffectedVerdict.Failed,
    binding_id: `binding_${repository}`,
    repository,
    base_commit: "a",
    head_commit: "b",
    declaration: { version: 1, command, time_limit_s: 600, gate_files: [] },
    changed: 2,
    report: null,
    failed,
    promoted_flaky: [],
    head: { command, exit_code: 1, signal: null, timed_out: false },
    output,
    duration_ms: 1,
    base_run: null,
    failure_text: affectedFailureText({
      repository,
      command,
      changed: 2,
      tests: 1,
      failed,
    }),
  };
}

test("the affected revision renders the rationale of each failed repository, the results and the first output", () => {
  const first = failedRun("api", "first output");
  const second = failedRun("web", "second output");
  const instruction = affectedRevisionInstruction(SHIPPED_TEMPLATES, [
    first,
    second,
  ]);
  assert.ok(
    instruction.includes(`${first.failure_text}\n\n${second.failure_text}`),
  );
  assert.ok(instruction.includes(JSON.stringify([first.head, second.head])));
  assert.match(instruction, /```text\nfirst output\n```$/);
  assert.doesNotMatch(instruction, /second output/);
});

test("the affected failure report joins the text of each failed repository and ends with the first output", () => {
  const first = failedRun("api", "first output");
  const second = failedRun("web", "second output");
  const passed = {
    ...failedRun("cli", "cli output"),
    verdict: "passed" as const,
  };
  const report = affectedFailureReport([first, passed, second]);
  assert.equal(
    report,
    `${first.failure_text}\n\n${second.failure_text}\n\nOutput of the failed run (the last 4 KiB):\n\n\`\`\`text\nfirst output\n\`\`\``,
  );
  assert.doesNotMatch(report, /second output|cli output/);
});

test("the affected failure report holds no output block for an empty output", () => {
  const run = failedRun("api", "");
  assert.equal(affectedFailureReport([run]), run.failure_text);
});
