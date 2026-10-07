import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import {
  ActorKind,
  ActorService,
  AssessmentResult,
  NodeState,
  ResumeTarget,
  actionKeySchema,
  actorSchema,
  attemptSchema,
  humanActSchema,
  overrideSchema,
  resumeSchema,
  unblockChangeSchema,
  unblockSchema,
  executionContextSchema,
  evidenceSubmitSchema,
  assessmentSubmitSchema,
  evidenceRequestSchema,
  evidenceDeleteSchema,
  nodeCheckSchema,
  assetSubmitSchema,
  mediaTypeSchema,
  OBJECT_SIZE_MAX,
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
  executionId: createIdentity("execution"),
  attempt: FIRST_REVISION,
  nodeRevision: FIRST_REVISION,
};
const PRODUCED = {
  kind: "produced",
  content: { mediaType: "text/plain", encoding: "base64", data: "" },
};
const ASSESSMENT = {
  ...CONTEXT,
  evidenceIds: [],
  childOutcomeIds: [],
  result: AssessmentResult.Success,
  rationale: REASON,
  testedInput: { kind: "produced", sha256: "a".repeat(64) },
};

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
        requirementKey: VALID_ACTION_KEY,
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
      input: { expectedMissionVersion: FIRST_REVISION, force: false },
    },
    {
      schema: nodeCheckSchema,
      input: { expectedMissionVersion: FIRST_REVISION },
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
    assessmentSubmitSchema.safeParse({ ...ASSESSMENT, evidenceIds: [id, id] })
      .success,
    false,
  );
  const outcomeId = createIdentity("outcome");
  assert.equal(
    assessmentSubmitSchema.safeParse({
      ...ASSESSMENT,
      childOutcomeIds: [outcomeId, outcomeId],
    }).success,
    false,
  );
});

test("object size, media type and forced-delete reason have exact bounds", () => {
  const object = {
    kind: "object",
    size: OBJECT_SIZE_MAX,
    mediaType: "text/plain",
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
  const deletion = { expectedMissionVersion: FIRST_REVISION, force: true };
  assert.equal(evidenceDeleteSchema.safeParse(deletion).success, false);
  assert.equal(
    evidenceDeleteSchema.safeParse({ ...deletion, reason: REASON }).success,
    true,
  );
});
const ACT = {
  reason: REASON,
  expectedMissionVersion: FIRST_REVISION,
  expectedState: NodeState.Available,
  expectedAttempt: ZERO_ATTEMPT,
};
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
const INPUTS = [
  { schema: humanActSchema, input: ACT },
  { schema: resumeSchema, input: { ...ACT, target: ResumeTarget.Waiting } },
  {
    schema: overrideSchema,
    input: { ...ACT, result: AssessmentResult.Success },
  },
  { schema: unblockChangeSchema, input: { content: CONTENT, reason: REASON } },
  {
    schema: unblockSchema,
    input: {
      blockedAttempt: ZERO_ATTEMPT,
      expected_revision: FIRST_REVISION,
      expectedMissionVersion: FIRST_REVISION,
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
  assert.equal(humanActSchema.parse(ACT).expectedAttempt, ZERO_ATTEMPT);
  assert.equal(
    humanActSchema.safeParse({ ...ACT, expectedAttempt: null }).success,
    false,
  );
  assert.equal(
    humanActSchema.safeParse({
      ...ACT,
      expectedAttempt: Number.MAX_SAFE_INTEGER + FIRST_REVISION,
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
