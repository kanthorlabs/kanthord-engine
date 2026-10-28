import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import {
  actionKeySchema,
  ActorKind,
  actorSchema,
  ActorService,
  admissionAnswerSchema,
  AdmissionRefusal,
  AssessmentResult,
  assessmentSubmitSchema,
  assetSubmitSchema,
  attemptSchema,
  contentSchema,
  deliveryAdmitSchema,
  Disposition,
  edgeSchema,
  evidenceDeleteSchema,
  evidenceRequestSchema,
  evidenceSubmitSchema,
  executionContextSchema,
  humanActSchema,
  Intent,
  mediaTypeSchema,
  NODE_IDENTITY_PREFIX,
  nodeCheckSchema,
  nodeCreateSchema,
  nodeSchema,
  NodeState,
  OBJECT_SIZE_MAX,
  overrideSchema,
  resumeSchema,
  ResumeTarget,
  TASK_IDENTITY_PREFIX,
  taskBodySchema,
  taskContentSchema,
  taskWriteSchema,
  unblockChangeSchema,
  unblockSchema,
} from "./contract.ts";

const ZERO_ATTEMPT = 0;
test("service provenance accepts an optional canonical snake-case inbound event identity", () => {
  const plain = { kind: ActorKind.Service, service: ActorService.Mission };
  const provenance = {
    ...plain,
    inbound_event_id: createIdentity("inbound_event"),
  };
  assert.deepEqual(actorSchema.parse(plain), plain);
  assert.deepEqual(actorSchema.parse(provenance), provenance);
  assert.equal(
    actorSchema.safeParse({ ...plain, inbound_event_id: "invalid" }).success,
    false,
  );
  assert.equal(
    actorSchema.safeParse({
      ...plain,
      inboundEventId: provenance.inbound_event_id,
    }).success,
    false,
  );
  assert.equal(
    actorSchema.safeParse({
      kind: ActorKind.Human,
      account: "ulrich",
      name: "Ulrich",
      inbound_event_id: provenance.inbound_event_id,
    }).success,
    false,
  );
});
const FIRST_REVISION = 1;
const REASON = "Hold the work";
const UNKNOWN_KEY = "unexpected";
const INVALID_RESULT = "failure";
const VALID_ACTION_KEY = "repo.pull_request";
const INVALID_ACTION_KEY = "repo.push";
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

test("object size, media type and forced-delete reason have exact bounds", () => {
  const object = {
    kind: "object",
    size: OBJECT_SIZE_MAX,
    media_type: "text/plain",
  };
  assert.equal(assetSubmitSchema.safeParse(object).success, true);
  assert.equal(
    assetSubmitSchema.safeParse({
      ...object,
      size: OBJECT_SIZE_MAX + FIRST_REVISION,
    }).success,
    false,
  );
  for (const mediaType of [
    "text/plain; charset=utf-8",
    "text",
    "téxt/plain",
    "text/plain\n",
    `${"a".repeat(128)}/b`,
  ])
    assert.equal(mediaTypeSchema.safeParse(mediaType).success, false);
  assert.equal(mediaTypeSchema.safeParse("text/plain").success, true);
  assert.equal(
    mediaTypeSchema.safeParse(`${"a".repeat(127)}/${"b".repeat(127)}`).success,
    true,
  );
  const deletion = { expected_mission_version: FIRST_REVISION, force: true };
  assert.equal(evidenceDeleteSchema.safeParse(deletion).success, false);
  assert.equal(
    evidenceDeleteSchema.safeParse({ ...deletion, reason: REASON }).success,
    true,
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

test("attempt-zero preconditions are accepted but opened attempts start at one", () => {
  assert.equal(humanActSchema.parse(ACT).expected_attempt, ZERO_ATTEMPT);
  assert.equal(
    humanActSchema.safeParse({ ...ACT, expected_attempt: null }).success,
    false,
  );
  assert.equal(
    humanActSchema.safeParse({
      ...ACT,
      expected_attempt: Number.MAX_SAFE_INTEGER + FIRST_REVISION,
    }).success,
    false,
  );
  assert.equal(
    attemptSchema.shape.attempt.safeParse(ZERO_ATTEMPT).success,
    false,
  );
  assert.equal(
    attemptSchema.shape.attempt.parse(FIRST_REVISION),
    FIRST_REVISION,
  );
});

test("override result and action keys use the ruled closed sets", () => {
  assert.equal(
    overrideSchema.safeParse({ ...ACT, result: INVALID_RESULT }).success,
    false,
  );
  assert.equal(
    overrideSchema.parse({ ...ACT, result: AssessmentResult.Success }).result,
    AssessmentResult.Success,
  );
  assert.equal(actionKeySchema.parse(VALID_ACTION_KEY), VALID_ACTION_KEY);
  assert.equal(actionKeySchema.safeParse(INVALID_ACTION_KEY).success, false);
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

test("the delivery admission input holds canonical base64 event bytes", () => {
  const body = {
    inbound_event_id: createIdentity("inbound_event"),
    project_id: createIdentity("project"),
    platform: "github",
    resource: "owner/gated",
    event: Buffer.from('{"number":1}').toString("base64"),
    metadata: { event: "pull_request" },
  };
  assert.deepEqual(deliveryAdmitSchema.parse(body), body);
  for (const event of ["QR==", "QQ", "not base64!"])
    assert.equal(
      deliveryAdmitSchema.safeParse({ ...body, event }).success,
      false,
    );
  assert.equal(
    deliveryAdmitSchema.safeParse({
      ...body,
      inboundEventId: body.inbound_event_id,
    }).success,
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

test("a task identity takes the task prefix and a task body names no binding", () => {
  const task = {
    id: createIdentity(TASK_IDENTITY_PREFIX),
    filename: "recover.md",
    content: CONTENT,
  };
  assert.equal(taskContentSchema.safeParse(task).success, true);
  assert.equal(
    taskContentSchema.safeParse({
      ...task,
      id: createIdentity(NODE_IDENTITY_PREFIX),
    }).success,
    false,
  );
  assert.equal(
    taskWriteSchema.safeParse({ filename: task.filename, content: CONTENT })
      .success,
    true,
  );
  assert.equal(
    taskBodySchema.safeParse({
      ...CONTENT,
      bindings: [createIdentity("binding")],
    }).success,
    false,
  );
});

test("a node create requires the task list", () => {
  const create = {
    filename: "recover.md",
    content: NODE_CONTENT,
    reason: REASON,
    expected_mission_version: FIRST_REVISION,
  };
  assert.equal(nodeCreateSchema.safeParse(create).success, false);
  assert.equal(
    nodeCreateSchema.safeParse({ ...create, tasks: [] }).success,
    true,
  );
});

test("node content holds intent and a tags list that reads [] when absent", () => {
  assert.deepEqual(contentSchema.parse(NODE_CONTENT).tags, []);
  assert.equal(
    contentSchema.safeParse({ ...NODE_CONTENT, intent: "task" }).success,
    false,
  );
  const { intent, ...noIntent } = NODE_CONTENT;
  assert.equal(intent, Intent.Implement);
  assert.equal(contentSchema.safeParse(noIntent).success, false);
  assert.equal(
    contentSchema.safeParse({
      ...NODE_CONTENT,
      tags: ["platform.macos", "toolchain.xcode_16"],
    }).success,
    true,
  );
  assert.equal(
    contentSchema.safeParse({ ...NODE_CONTENT, tags: ["platform.macOS"] })
      .success,
    false,
  );
  assert.equal(
    taskBodySchema.safeParse({ ...CONTENT, intent: Intent.Implement }).success,
    false,
  );
});

test("a repeated key fails", () => {
  assert.equal(
    contentSchema.safeParse({
      ...NODE_CONTENT,
      tags: ["platform.macos", "platform.macos"],
    }).success,
    false,
  );
});

test("a node create takes no parent and the node read holds intent and tags", () => {
  const create = {
    filename: "recover.md",
    content: NODE_CONTENT,
    tasks: [],
    reason: REASON,
    expected_mission_version: FIRST_REVISION,
  };
  assert.equal(nodeCreateSchema.safeParse(create).success, true);
  assert.deepEqual(Object.keys(nodeCreateSchema.shape).sort(), [
    "content",
    "expected_mission_version",
    "filename",
    "reason",
    "tasks",
  ]);
  assert.deepEqual(Object.keys(nodeSchema.shape).sort(), [
    "attempt",
    "blocked_context",
    "content",
    "depends_on",
    "filename",
    "id",
    "intent",
    "mission_id",
    "pinned_by_attempts",
    "pinned_revision",
    "priority",
    "retired_at",
    "state",
    "tags",
    "tasks",
    "visible_revision",
  ]);
});

test("an edge names the dependent and the dependency alone", () => {
  const edge = {
    dependent_id: createIdentity(NODE_IDENTITY_PREFIX),
    depends_on_id: createIdentity(NODE_IDENTITY_PREFIX),
  };
  assert.equal(edgeSchema.safeParse(edge).success, true);
  assert.equal(
    edgeSchema.safeParse({ ...edge, kind: "dependency" }).success,
    false,
  );
});
