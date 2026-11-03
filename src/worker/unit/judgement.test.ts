import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedFailureReport,
  affectedRevisionInstruction,
  criterionRevisionInstruction,
  evaluationInstruction,
  evaluationJudgementSchemaOf,
  examineInstruction,
  failedChecksText,
  failedVerificationRationale,
  failedVerificationReport,
  JUDGEMENT_MARKER,
  judgementBlockers,
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
import { type Finding, FindingKind } from "../../mission/contract.ts";

const evaluationJudgementSchema = evaluationJudgementSchemaOf({
  priorIds: [],
  priorBlockerIds: [],
  taskIds: ["task"],
});

const BLOCKER = {
  label: "B1",
  action: "yes",
  task_id: "task",
  ground: "unstated",
  name: "No test",
  description: "no test",
  fix: "Add a test",
  why: "The criterion asks for a test",
};
const GROUNDED_REPLY = `kanthord-judgement: ${JSON.stringify({
  result: "criterion-not-met",
  rationale: "r",
  findings: [BLOCKER],
})}`;
const UNGROUNDED_REPLY = `kanthord-judgement: ${JSON.stringify({
  result: "criterion-not-met",
  rationale: "r",
  findings: [{ ...BLOCKER, ground: null }],
})}`;
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
  assert.deepEqual(parseJudgement(text, evaluationJudgementSchema).reply, {
    result: "success",
    rationale: "final",
    findings: [],
    fixed_finding_ids: [],
    proposals: [],
  });
  for (const invalid of [
    undefined,
    "missing",
    "kanthord-judgement: invalid",
    'kanthord-judgement: {"result":"success","rationale":" "}',
    'kanthord-judgement: {"result":"success","rationale":"yes","extra":true}',
    'kanthord-judgement: {"result":"criterion-not-met","rationale":"r","unmet":[{"id":"task","reason":"no test","ground":"stated"}]}',
  ])
    assert.equal(
      parseJudgement(invalid, evaluationJudgementSchema).reply,
      null,
    );
  assert.deepEqual(
    parseJudgement(GROUNDED_REPLY, evaluationJudgementSchema).reply,
    {
      result: "criterion-not-met",
      rationale: "r",
      findings: [BLOCKER],
      fixed_finding_ids: [],
      proposals: [],
    },
  );
  assert.equal(
    parseJudgement(
      'kanthord-judgement: {"result":"criterion-not-met","rationale":"task failed"}',
      evaluationJudgementSchema,
    ).reply,
    null,
  );
  assert.equal(
    judgementRationale({
      rationale: "two gaps",
      blockers: [
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
      blockers: [
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
      blockers: [
        { id: "task_b", reason: "no test asked", ground: UnmetGround.Unstated },
      ],
    }),
    PLAN_GAP_RATIONALE,
  );
  assert.equal(
    judgementRationale({ rationale: MET_RATIONALE, blockers: [] }),
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
    round: { number: 1, review_base: null },
    priorFindings: [],
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
    /A blocker requires criterion-not-met, and success holds no blocker\. Give each item of your finding list as one item of findings\. Give each item its label, action, name, description, fix and why\. Report each defect once\. Put the task id in task_id, or null for the node criterion or the default standard\./,
  );
  assert.doesNotMatch(instruction, /prose style/);
  assert.doesNotMatch(instruction, /unmet/);
  assert.match(
    instruction,
    /in the review bundle\. If the review bundle holds a coder report, read it\. Judge each OPEN blocker of the coder report: list it as a blocker finding with its ground, or state in the rationale why it is not a defect\. An OPEN blocker of the coder report that the node scope forbids is a blocker finding with the conflict ground\. An answer of the coder report to a prior finding id is no coder blocker\. A coder blocker is exempt from the patch rule\. Weigh each current dependency outcome/,
  );
  assert.doesNotMatch(examineEvaluation, /coder report/);
  assert.match(
    instruction,
    /Give each blocker a ground: stated for a requirement or criterion of the work prompt, standard for a default-standard rule, unstated for a defect that neither states, conflict for two stated requirements or criteria that the work cannot meet together\. Give each suggestion the ground null\./,
  );
  assert.match(
    instruction,
    /conflict for two stated requirements or criteria that the work cannot meet together\. Give each suggestion the ground null\. For example, correct work fails a criterion, a verification or an affected test unless it changes a file that the requirement forbids\. A failure that a defect of the work causes is no conflict\. For a conflict, write the description as the two requirements in quotes, joined by " vs ": "requirement A" vs "requirement B"\. Write every description in full; do not cite another finding label\./,
  );
  assert.match(
    instruction,
    /`changed_files` in the review bundle lists every file that the change under review adds, modifies or deletes\./,
  );
  assert.match(
    instruction,
    /A changed file that the requirement forbids is a blocker with the ground stated\. The exception is a change that correct work needs for a criterion, a verification or an affected test\./,
  );
  assert.match(
    instruction,
    /"findings": \[\{"label": "B1", "action": "yes", "task_id": null, "ground": "stated", "name": "Short name", "description": "The concrete defect", "fix": "The recommended change", "why": "The reason for the action"\}\], "fixed_finding_ids": \[\]/,
  );
  assert.doesNotMatch(instruction, /review round|Prior findings/);
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
  assert.match(
    withOutput,
    /^Revise the task work to satisfy its criterion and verifications\. When a verification or an affected test needs a change to a forbidden file, make the smallest such change\. Verification 1/,
  );
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
const FORBIDDEN_FILE_RULE =
  /When a verification or an affected test needs a change to a forbidden file, make the smallest such change\./;

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
  assert.match(
    releaseRevisionInstruction(
      SHIPPED_TEMPLATES,
      verification,
      [RELEASE_COMMAND],
      NO_OUTPUT,
    ),
    FORBIDDEN_FILE_RULE,
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

test("a blocker finding requires a ground of the closed set", () => {
  assert.deepEqual(Object.values(UnmetGround), [
    "stated",
    "standard",
    "unstated",
    "conflict",
  ]);
  assert.equal(unmetGroundSchema.safeParse("other").success, false);
  assert.equal(
    parseJudgement(UNGROUNDED_REPLY, evaluationJudgementSchema).reply,
    null,
  );
  assert.equal(
    parseJudgement(
      GROUNDED_REPLY.replace("unstated", "other"),
      evaluationJudgementSchema,
    ).reply,
    null,
  );
  assert.equal(
    parseJudgement(GROUNDED_REPLY, evaluationJudgementSchema).reply?.findings[0]
      ?.ground,
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
    (second.reply as { findings: { ground: string }[] }).findings.at(0)?.ground,
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
  assert.match(instruction, FORBIDDEN_FILE_RULE);
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

const PRIOR_BLOCKER_ID = "finding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const PRIOR_SUGGESTION_ID = "finding_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const UNLISTED_BLOCKER_RATIONALE = "r\nUnmet:\n- node: defect B1";
const PLAIN_REVISION =
  "Revise the task work to meet its criterion. Previous judgement: r";
const ROUND_SCHEMA = evaluationJudgementSchemaOf({
  priorIds: [PRIOR_BLOCKER_ID, PRIOR_SUGGESTION_ID],
  priorBlockerIds: [PRIOR_BLOCKER_ID],
  taskIds: ["task"],
});
const SUGGESTION = { ...BLOCKER, label: "S1", ground: null };

function priorFinding(id: string, label: string): Finding {
  const blocker = label.startsWith("B");
  return {
    id,
    node_id: "node",
    attempt: 1,
    round: 1,
    assessment_id: "assessment_01ARZ3NDEKTSV4RRFFQ69G5FAD",
    source: "reviewer",
    label,
    kind: blocker ? FindingKind.Blocker : FindingKind.Suggestion,
    action: "yes",
    task_id: blocker ? null : "task",
    ground: blocker ? "stated" : null,
    name: `name ${label}`,
    description: `defect ${label}`,
    fix: `fix ${label}`,
    why: `why ${label}`,
    route: "fix",
    status: "open",
    fixed_assessment_id: null,
    cause_owner: null,
    created_by: null,
    created_at: 0,
    decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
  };
}

function judged(body: Record<string, unknown>) {
  return parseJudgement(
    `kanthord-judgement: ${JSON.stringify({ rationale: "r", ...body })}`,
    ROUND_SCHEMA,
  );
}

function refusedAt(body: Record<string, unknown>, path: string) {
  const parsed = judged(body);
  assert.equal(parsed.reply, null, JSON.stringify(body));
  assert.ok(
    parsed.issues?.some((issue) => issue.path === path),
    `${path} in ${JSON.stringify(parsed.issues)}`,
  );
}

test("the judgement schema refuses each value that the Mission Service refuses", () => {
  const fixed = { fixed_finding_ids: [PRIOR_BLOCKER_ID] };
  refusedAt(
    { result: "criterion-not-met", findings: [{ ...BLOCKER, label: "X1" }] },
    "findings.0.label",
  );
  refusedAt(
    { result: "criterion-not-met", findings: [{ ...BLOCKER, label: "B0" }] },
    "findings.0.label",
  );
  refusedAt(
    {
      result: "criterion-not-met",
      findings: [{ ...BLOCKER, label: "B1000" }],
    },
    "findings.0.label",
  );
  refusedAt(
    { result: "criterion-not-met", findings: [BLOCKER, BLOCKER] },
    "findings.1.label",
  );
  refusedAt(
    { result: "criterion-not-met", findings: [{ ...BLOCKER, action: "no" }] },
    "findings.0.action",
  );
  refusedAt(
    { result: "criterion-not-met", findings: [{ ...BLOCKER, ground: null }] },
    "findings.0.ground",
  );
  refusedAt(
    {
      result: "success",
      ...fixed,
      findings: [{ ...SUGGESTION, ground: "stated" }],
    },
    "findings.0.ground",
  );
  refusedAt(
    {
      result: "success",
      ...fixed,
      findings: [{ ...SUGGESTION, task_id: "other" }],
    },
    "findings.0.task_id",
  );
  refusedAt(
    { result: "success", ...fixed, findings: [{ ...SUGGESTION, fix: " " }] },
    "findings.0.fix",
  );
  refusedAt(
    {
      result: "success",
      ...fixed,
      findings: [{ ...SUGGESTION, why: "x".repeat(8193) }],
    },
    "findings.0.why",
  );
  refusedAt(
    {
      result: "success",
      ...fixed,
      findings: Array.from({ length: 101 }, (_, index) => ({
        ...SUGGESTION,
        label: `S${index + 1}`,
      })),
    },
    "findings",
  );
  refusedAt({ result: "success", ...fixed, findings: [BLOCKER] }, "findings");
  refusedAt(
    { result: "criterion-not-met", ...fixed, findings: [SUGGESTION] },
    "findings",
  );
  assert.ok(
    judged({
      result: "success",
      ...fixed,
      findings: [{ ...SUGGESTION, why: "x".repeat(8192) }],
    }).reply,
  );
  assert.ok(
    judged({
      result: "success",
      ...fixed,
      findings: Array.from({ length: 100 }, (_, index) => ({
        ...SUGGESTION,
        label: `S${index + 1}`,
      })),
    }).reply,
  );
});

test("fixed_finding_ids names each prior finding once, and success lists each prior blocker", () => {
  refusedAt(
    {
      result: "success",
      fixed_finding_ids: [
        PRIOR_BLOCKER_ID,
        "finding_01ARZ3NDEKTSV4RRFFQ69G5FAE",
      ],
    },
    "fixed_finding_ids.1",
  );
  refusedAt(
    {
      result: "success",
      fixed_finding_ids: [PRIOR_BLOCKER_ID, PRIOR_BLOCKER_ID],
    },
    "fixed_finding_ids.1",
  );
  refusedAt(
    { result: "success", fixed_finding_ids: [PRIOR_SUGGESTION_ID] },
    "fixed_finding_ids",
  );
  assert.deepEqual(
    judged({ result: "success", fixed_finding_ids: [PRIOR_BLOCKER_ID] }).reply
      ?.fixed_finding_ids,
    [PRIOR_BLOCKER_ID],
  );
});

test("a criterion-not-met that rests only on an unlisted prior blocker is admitted and names that blocker", () => {
  const parsed = judged({
    result: "criterion-not-met",
    findings: [SUGGESTION],
    fixed_finding_ids: [PRIOR_SUGGESTION_ID],
  });
  assert.ok(parsed.reply);
  const prior = [
    priorFinding(PRIOR_BLOCKER_ID, "B1"),
    priorFinding(PRIOR_SUGGESTION_ID, "S1"),
  ];
  const blockers = judgementBlockers("node", parsed.reply, prior);
  assert.deepEqual(blockers, [
    { id: "node", reason: "defect B1", ground: UnmetGround.Stated },
  ]);
  assert.equal(
    judgementRationale({ rationale: "r", blockers }),
    UNLISTED_BLOCKER_RATIONALE,
  );
  assert.deepEqual(
    judgementBlockers(
      "node",
      { findings: [BLOCKER] as never, fixed_finding_ids: [PRIOR_BLOCKER_ID] },
      prior,
    ),
    [{ id: "task", reason: "no test", ground: UnmetGround.Unstated }],
  );
});

test("the issues of a refused line reach the repair text", async () => {
  const absent = parseJudgement("no marker", ROUND_SCHEMA);
  assert.deepEqual(absent, { reply: null, issues: [] });
  assert.equal(
    repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER, absent.issues!),
    JUDGEMENT_REPAIR,
  );
  const refused = repairAgent([UNGROUNDED_REPLY, GROUNDED_REPLY]);
  await parseRepaired(
    SHIPPED_TEMPLATES,
    refused.agent,
    {} as WorkPrompt,
    evaluationJudgementSchema,
  );
  assert.equal(
    refused.instructions[0],
    `${JUDGEMENT_REPAIR} Correct each issue of the last line: ${JSON.stringify([
      { path: "findings.0.ground", message: "A blocker holds a ground" },
    ])}`,
  );
});

test("a round with a review base renders the round block with the prior findings", () => {
  const verification = { tested_input: [], results: [] } as never;
  const base = {
    tasks: [],
    verification,
    evidence: [],
    affected: null,
  };
  const prior = [priorFinding(PRIOR_BLOCKER_ID, "B1")];
  const reviewBase = [
    { kind: "repository", binding_id: "binding", commit: "a".repeat(40) },
  ];
  const instruction = evaluationInstruction(SHIPPED_TEMPLATES, {
    ...base,
    round: { number: 2, review_base: reviewBase },
    priorFindings: prior,
  });
  assert.match(
    instruction,
    /^This is review round 2\. `patch_paths` in the review bundle lists the patch of each repository since the latest review with a judgement\. Review only that change: raise a new finding only on a line that a patch adds or changes\. List each prior finding that the change fixes in fixed_finding_ids\. Never report a prior finding again\. A finding that you do not list stays open\. A prior blocker that you do not list stays a blocker of this judgement\.$/m,
  );
  const line = instruction
    .split("\n")
    .find((entry) => entry.startsWith("Prior findings: "));
  assert.deepEqual(JSON.parse(line!.slice("Prior findings: ".length)), [
    {
      id: PRIOR_BLOCKER_ID,
      label: "B1",
      round: 1,
      kind: "blocker",
      action: "yes",
      task_id: null,
      ground: "stated",
      name: "name B1",
      description: "defect B1",
      fix: "fix B1",
      why: "why B1",
    },
  ]);
  assert.doesNotMatch(
    evaluationInstruction(SHIPPED_TEMPLATES, {
      ...base,
      round: { number: 2, review_base: null },
      priorFindings: prior,
    }),
    /review round|Prior findings/,
  );
});

test("the criterion revision lists each open finding with its id and asks for an answer per id", () => {
  assert.equal(
    criterionRevisionInstruction(SHIPPED_TEMPLATES, "r"),
    PLAIN_REVISION,
  );
  const text = criterionRevisionInstruction(SHIPPED_TEMPLATES, "r", [
    priorFinding(PRIOR_BLOCKER_ID, "B1"),
    { ...priorFinding(PRIOR_SUGGESTION_ID, "S1"), round: 2 },
  ]);
  assert.equal(
    text,
    [
      PLAIN_REVISION,
      "",
      "Resolve each finding below. Change only what each finding needs, because the next review reads only the change since the latest review with a judgement. In your final reply, answer each finding id with FIXED or OPEN and the reason. A finding answer is no blocker of your finding list.",
      `- ${PRIOR_BLOCKER_ID} (B1, round 1) name B1: defect B1 fix: fix B1 why: why B1`,
      `- ${PRIOR_SUGGESTION_ID} (S1, round 2) name S1: defect S1 fix: fix S1 why: why S1`,
    ].join("\n"),
  );
});
