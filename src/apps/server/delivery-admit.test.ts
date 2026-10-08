import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { OperationError } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import {
  ActorKind,
  ActorService,
  AdmissionRefusal,
  CheckEndState,
  Disposition,
  EndState,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeState,
} from "../../mission/contract.ts";
import {
  REQUEST_NUMBER,
  externalRequestHarness,
} from "../../mission/test-support.ts";
import { decodeGitHubEvent } from "../../repository/index.ts";

const RESOURCE = "owner/repo";
const MERGE_COMMIT = "e".repeat(40);
const OTHER_NUMBER = 9;
const FIRST_ATTEMPT = 1;
const SINGLE_CALL = 1;
const NO_CALLS = 0;
const CHECK_FAILURE_CODE = "repository.platform.github.retryable_refusal";
const BAD_GATEWAY_STATUS = 502;

function closed(number: number, merged: boolean): string {
  return Buffer.from(
    JSON.stringify({
      action: "closed",
      number,
      pull_request: { merged },
      repository: { full_name: RESOURCE },
    }),
  ).toString("base64");
}

async function fixture(t: TestContext) {
  const h = await externalRequestHarness(
    t,
    mintServiceIdentity(INTAKE_SERVICE_NAME),
  );
  h.dependencies.decoder = {
    decode: ({ resource, event, metadata }) =>
      decodeGitHubEvent({ resource, event, metadata }),
  };
  const checks: string[] = [];
  const answer = (
    end_state: (typeof CheckEndState)[keyof typeof CheckEndState],
    landed_commits: string[] = [],
  ) => {
    h.dependencies.intakeCheck.check = async (_context, evidenceId) => {
      checks.push(evidenceId);
      return { end_state, landed_commits };
    };
  };
  const admit = (
    inboundEventId = createIdentity("inbound_event"),
    event = closed(REQUEST_NUMBER, true),
    eventType = "pull_request",
  ) =>
    h.invoke("delivery.admit", {
      params: {},
      query: {},
      body: {
        inbound_event_id: inboundEventId,
        project_id: h.project_id,
        platform: "github",
        resource: RESOURCE,
        event,
        metadata: { event: eventType },
      },
    });
  return { ...h, checks, answer, admit };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

async function evidenceOf(h: Harness) {
  return (
    await h.invoke("evidence.list", {
      params: { node_id: h.node_id },
      query: { attempt: FIRST_ATTEMPT },
      body: null,
    })
  ).items;
}

async function landedOf(h: Harness) {
  return (await evidenceOf(h)).filter(
    (item) => item.provenance.kind === ActorKind.Service,
  );
}

async function requestOf(h: Harness) {
  return (await evidenceOf(h)).find((item) => item.id === h.request.id);
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(
    promise,
    (error) => error instanceof OperationError && error.code === code,
  );
}

test("a merged pull request sets expected, writes the landed commit with the inbound event and completes the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  const inboundEventId = createIdentity("inbound_event");
  assert.deepEqual(await h.admit(inboundEventId), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.deepEqual(h.checks, [h.request.id]);
  assert.equal((await requestOf(h))?.end_state, EndState.Expected);
  const landed = await landedOf(h);
  assert.equal(landed.length, SINGLE_CALL);
  assert.deepEqual(landed[0]!.provenance, {
    kind: ActorKind.Service,
    service: ActorService.Mission,
    inbound_event_id: inboundEventId,
  });
  assert.equal(h.node().state, NodeState.Completed);
});

test("a repeat answers duplicate and writes nothing", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  await h.admit();
  const before = await evidenceOf(h);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.Duplicate,
    reason: null,
  });
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.deepEqual(await evidenceOf(h), before);
});

test("a closed pull request sets other and blocks the node", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Other);
  assert.deepEqual(await h.admit(undefined, closed(REQUEST_NUMBER, false)), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal((await requestOf(h))?.end_state, EndState.Other);
  assert.equal((await landedOf(h)).length, NO_CALLS);
  assert.equal(h.node().state, NodeState.Blocked);
});

test("an open pull request answers accepted_observation and writes nothing", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.None);
  const before = await evidenceOf(h);
  assert.deepEqual(await h.admit(), {
    disposition: Disposition.AcceptedObservation,
    reason: null,
  });
  assert.equal(h.checks.length, SINGLE_CALL);
  assert.deepEqual(await evidenceOf(h), before);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("a failed check propagates its code and writes nothing", async (t) => {
  const h = await fixture(t);
  h.dependencies.intakeCheck.check = async () => {
    throw new OperationError(
      BAD_GATEWAY_STATUS,
      CHECK_FAILURE_CODE,
      "Retryable refusal.",
    );
  };
  const before = await evidenceOf(h);
  await rejectsWith(h.admit(), CHECK_FAILURE_CODE);
  assert.deepEqual(await evidenceOf(h), before);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("an undecodable or unmatched event refuses before any check", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  const issue = Buffer.from(
    JSON.stringify({
      action: "opened",
      issue: { number: 3 },
      repository: { full_name: RESOURCE },
    }),
  ).toString("base64");
  assert.deepEqual(await h.admit(undefined, issue, "issues"), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Undecodable,
  });
  assert.deepEqual(await h.admit(undefined, closed(OTHER_NUMBER, true)), {
    disposition: Disposition.Refused,
    reason: AdmissionRefusal.Unmatched,
  });
  assert.equal(h.checks.length, NO_CALLS);
  assert.equal(h.node().state, NodeState.ExternalRequested);
});

test("another service identity refuses with service_mismatch", async (t) => {
  const h = await fixture(t);
  h.answer(CheckEndState.Expected, [MERGE_COMMIT]);
  h.caller.identity = mintServiceIdentity(MISSION_SERVICE_NAME);
  await assert.rejects(
    h.admit(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.AuthorizationRefused &&
      JSON.stringify(error.details) ===
        JSON.stringify({ reason: "service_mismatch" }),
  );
  assert.equal(h.checks.length, NO_CALLS);
});
