import assert from "node:assert/strict";
import { test } from "node:test";
import {
  affectedFailureReport,
  evaluationJudgementSchemaOf,
  judgementBlockers,
  judgementRationale,
  linkUpdatesText,
  parseJudgement,
  parseRepaired,
  releaseRevisionInstruction,
  ReplyRepair,
  REQUESTED_CHANGES_MAX_BYTES,
  requestedChangesText,
  taskRevisionInstruction,
  UnmetGround,
  withFlakyVerification,
} from "./judgement.ts";
import {
  affectedFailureText,
  type AffectedRun,
  AffectedVerdict,
} from "./affected.ts";
import type { Verification } from "./verification.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import type { NativeAgent } from "./native-agent.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import {
  type Finding,
  FINDING_TEXT_MAX_BYTES,
  FindingKind,
} from "../../mission/contract.ts";

const FLAKY_OUTPUT_CHARS = 2048;
const LINK_NUMBER = 7;
const LINK_TIME = 1760000000000;
const ONE_MISSING = 1;
const FIRST_UPDATE = 1;
const LONG_BODY_FACTOR = 4;

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

test("the Flaky verification description keeps the finding text bound for several large outputs", () => {
  const failure = (index: number) => ({
    index,
    command: `npm test ${index}`,
    result: {
      command: "npm test",
      exit_code: 1,
      signal: null,
      timed_out: false,
    },
    output: "é".repeat(FLAKY_OUTPUT_CHARS),
  });
  const judged = withFlakyVerification({ rationale: "met", findings: [] }, [
    failure(0),
    failure(1),
    failure(2),
  ]);
  const description = judged.findings[0]?.description ?? "";
  assert.ok(Buffer.byteLength(description, "utf8") <= FINDING_TEXT_MAX_BYTES);
  assert.match(description, /Verification 3 `npm test 2`/);
  assert.doesNotMatch(description, /\uFFFD/);
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

const SINGLE_REPAIR = 1;

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

const PRIOR_BLOCKER_ID = "finding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const PRIOR_SUGGESTION_ID = "finding_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const UNLISTED_BLOCKER_RATIONALE = "r\nUnmet:\n- node: defect B1";
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

function linkUpdate(index: number, overrides: object = {}) {
  return {
    id: `link_update_${String(index).padStart(2, "0")}`,
    external_link: {
      kind: "github_issue",
      resource_identity: "conversation:github:octo/widgets",
      number: LINK_NUMBER,
    },
    update_key: `issue_comment:${index}`,
    occurred_at: LINK_TIME + index,
    new: false,
    content: {
      author: `author${index}`,
      body: `body ${index}.`,
      url: `https://github.com/octo/widgets/issues/7#issuecomment-${index}`,
      occurred_at: LINK_TIME + index,
    },
    ...overrides,
  };
}

test("the link updates text cuts no body and states no older updates when the page holds all", () => {
  const body = "x".repeat(REQUESTED_CHANGES_MAX_BYTES * LONG_BODY_FACTOR);
  const text = linkUpdatesText({
    items: [
      linkUpdate(FIRST_UPDATE, {
        content: {
          author: "octocat",
          body,
          url: "https://example.test/u",
          occurred_at: LINK_TIME,
        },
      }),
    ],
    next_cursor: null,
    total: ONE_MISSING,
  });
  assert.ok(text?.includes(body));
  assert.equal(text?.includes("older updates"), false);
  assert.equal(
    linkUpdatesText({ items: [], next_cursor: null, total: 0 }),
    null,
  );
});
