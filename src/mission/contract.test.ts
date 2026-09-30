import assert from "node:assert/strict";
import { test } from "node:test";
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
} from "./contract.ts";

const ZERO_ATTEMPT = 0;
const FIRST_REVISION = 1;
const REASON = "Hold the work";
const UNKNOWN_KEY = "unexpected";
const INVALID_RESULT = "failure";
const VALID_ACTION_KEY = "repo.pull_request";
const INVALID_ACTION_KEY = "repo.push";
const HUMAN = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
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
      expectedRevision: FIRST_REVISION,
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
