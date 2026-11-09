import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import {
  ActorKind,
  actorSchema,
  ActorService,
  admissionAnswerSchema,
  AdmissionRefusal,
  AssessmentResult,
  assessmentSubmitSchema,
  contentSchema,
  Disposition,
  evidenceDeleteSchema,
  evidenceRequestSchema,
  evidenceSubmitSchema,
  executionContextSchema,
  ExternalLinkKind,
  humanActSchema,
  Intent,
  nodeCheckSchema,
  NodeState,
  overrideSchema,
  resumeSchema,
  ResumeTarget,
  unblockChangeSchema,
  unblockSchema,
} from "./contract.ts";

const ZERO_ATTEMPT = 0;
const FIRST_REVISION = 1;
const REASON = "Hold the work";
const UNKNOWN_KEY = "unexpected";
const VALID_ACTION_KEY = "repo.pull_request";
const HUMAN = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const CONTEXT = {
  execution_id: createIdentity("execution"),
  attempt: FIRST_REVISION,
  node_revision: FIRST_REVISION,
};
const PRODUCED = {
  kind: "produced",
  content: { media_type: "text/plain", encoding: "base64", data: "" },
};
const ASSESSMENT = {
  ...CONTEXT,
  evidence_ids: [],
  dependency_outcome_ids: [],
  result: AssessmentResult.Success,
  rationale: REASON,
  tested_input: { kind: "produced", sha256: "a".repeat(64) },
};
test("the assessment body requires a cause with the result criterion-not-met and refuses it with another result", () => {
  const cause = {
    category: "model",
    assigner: "rule",
    subcategory: "work_defect",
  };
  const notMet = { ...ASSESSMENT, result: AssessmentResult.CriterionNotMet };
  assert.equal(
    assessmentSubmitSchema.safeParse({ ...notMet, cause }).success,
    true,
  );
  const missing = assessmentSubmitSchema.safeParse(notMet);
  assert.equal(missing.success, false);
  assert.deepEqual(missing.error?.issues[0]?.path, ["cause"]);
  const refused = assessmentSubmitSchema.safeParse({ ...ASSESSMENT, cause });
  assert.equal(refused.success, false);
  assert.deepEqual(refused.error?.issues[0]?.path, ["cause"]);
});

test("execution and evidence control inputs are strict and refuse forged actors", () => {
  const inputs = [
    { schema: executionContextSchema, input: CONTEXT },
    {
      schema: evidenceSubmitSchema,
      input: { ...CONTEXT, subject: REASON, assets: [PRODUCED] },
    },
    { schema: assessmentSubmitSchema, input: ASSESSMENT },
    {
      schema: evidenceRequestSchema,
      input: {
        ...CONTEXT,
        requirement_key: VALID_ACTION_KEY,
        subject: REASON,
        address: {
          kind: "pull_request",
          resource_identity: "repository:github:owner/repo",
          number: 42,
        },
      },
    },
    {
      schema: evidenceDeleteSchema,
      input: { expected_mission_version: FIRST_REVISION, force: false },
    },
    {
      schema: nodeCheckSchema,
      input: { expected_mission_version: FIRST_REVISION },
    },
  ];
  for (const { schema, input } of inputs) {
    assert.equal(schema.safeParse(input).success, true);
    assert.equal(
      schema.safeParse({ ...input, unexpected: true }).success,
      false,
    );
    assert.equal(schema.safeParse({ ...input, actor: HUMAN }).success, false);
  }
  assert.equal(
    executionContextSchema.safeParse({ ...CONTEXT, attempt: ZERO_ATTEMPT })
      .success,
    false,
  );
  assert.equal(
    assessmentSubmitSchema.safeParse({ ...ASSESSMENT, method: "evaluation" })
      .success,
    false,
  );
  const id = createIdentity("evidence");
  assert.equal(
    assessmentSubmitSchema.safeParse({ ...ASSESSMENT, evidence_ids: [id, id] })
      .success,
    false,
  );
  const outcomeId = createIdentity("outcome");
  assert.equal(
    assessmentSubmitSchema.safeParse({
      ...ASSESSMENT,
      dependency_outcome_ids: [outcomeId, outcomeId],
    }).success,
    false,
  );
});

const ACT = {
  reason: REASON,
  expected_mission_version: FIRST_REVISION,
  expected_state: NodeState.Available,
  expected_attempt: ZERO_ATTEMPT,
};
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
const NODE_CONTENT = { ...CONTENT, intent: Intent.Implement };
const INPUTS = [
  { schema: humanActSchema, input: ACT },
  { schema: resumeSchema, input: { ...ACT, target: ResumeTarget.Waiting } },
  {
    schema: overrideSchema,
    input: { ...ACT, result: AssessmentResult.Success },
  },
  {
    schema: unblockChangeSchema,
    input: { content: NODE_CONTENT, tasks: [], reason: REASON },
  },
  {
    schema: unblockSchema,
    input: {
      blocked_attempt: ZERO_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expected_mission_version: FIRST_REVISION,
    },
  },
];

test("human control inputs reject unknown fields and forged actors", () => {
  for (const { schema, input } of INPUTS) {
    assert.equal(schema.safeParse(input).success, true);
    assert.equal(
      schema.safeParse({ ...input, [UNKNOWN_KEY]: true }).success,
      false,
    );
    assert.equal(schema.safeParse({ ...input, actor: HUMAN }).success, false);
  }
});

test("service actors admit Mission and Scheduler only", () => {
  for (const service of Object.values(ActorService)) {
    const actor = { kind: ActorKind.Service, service };
    assert.deepEqual(actorSchema.parse(actor), actor);
    assert.equal(
      actorSchema.safeParse({ ...actor, actor: HUMAN }).success,
      false,
    );
  }
  assert.equal(
    actorSchema.safeParse({ kind: ActorKind.Service, service: UNKNOWN_KEY })
      .success,
    false,
  );
});

test("the delivery admission answer carries a reason only for a refusal", () => {
  for (const reason of Object.values(AdmissionRefusal))
    assert.ok(
      admissionAnswerSchema.safeParse({
        disposition: Disposition.Refused,
        reason,
      }).success,
    );
  for (const disposition of [
    Disposition.AcceptedObservation,
    Disposition.Duplicate,
  ]) {
    assert.ok(
      admissionAnswerSchema.safeParse({ disposition, reason: null }).success,
    );
    assert.equal(
      admissionAnswerSchema.safeParse({
        disposition,
        reason: AdmissionRefusal.Unmatched,
      }).success,
      false,
    );
  }
  assert.equal(
    admissionAnswerSchema.safeParse({
      disposition: Disposition.Refused,
      reason: null,
    }).success,
    false,
  );
});

const CONVERSATION_IDENTITY = "conversation:github:acme/app";
const ISSUE_NUMBER = 117;
const GITHUB_ISSUE = {
  kind: ExternalLinkKind.GitHubIssue,
  resource_identity: CONVERSATION_IDENTITY,
  number: ISSUE_NUMBER,
};

const JIRA_IDENTITY = "conversation:jira:acme.atlassian.net/KD";
const JIRA_ISSUE = {
  kind: ExternalLinkKind.JiraIssue,
  resource_identity: JIRA_IDENTITY,
  key: "KD-42",
};

test("node content refuses a jira_issue link with a key of another project or outside its form", () => {
  const refused: unknown[] = [
    { ...JIRA_ISSUE, key: "OTHER-1" },
    { ...JIRA_ISSUE, key: "KDX-1" },
    { ...JIRA_ISSUE, key: "KD-0" },
    { ...JIRA_ISSUE, key: "KD-01" },
    { ...JIRA_ISSUE, key: "KD-" },
    { ...JIRA_ISSUE, key: "KD42" },
    { ...JIRA_ISSUE, key: "kd-42" },
    { ...JIRA_ISSUE, key: "KD-42 " },
    { ...JIRA_ISSUE, number: ISSUE_NUMBER },
    { ...JIRA_ISSUE, resource_identity: CONVERSATION_IDENTITY },
    {
      ...JIRA_ISSUE,
      resource_identity: "conversation:jira:acme.example.com/KD",
    },
    {
      ...JIRA_ISSUE,
      resource_identity: "conversation:jira:acme.atlassian.net/kd",
    },
    {
      ...JIRA_ISSUE,
      resource_identity: "repository:jira:acme.atlassian.net/KD",
    },
    { ...GITHUB_ISSUE, key: "KD-42" },
  ];
  for (const link of refused)
    assert.equal(
      contentSchema.safeParse({ ...NODE_CONTENT, external_links: [link] })
        .success,
      false,
      JSON.stringify(link),
    );
  assert.equal(
    contentSchema.safeParse({
      ...NODE_CONTENT,
      external_links: [JIRA_ISSUE, { ...JIRA_ISSUE }],
    }).success,
    false,
  );
});
