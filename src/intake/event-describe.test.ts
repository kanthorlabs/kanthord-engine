import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { SensitiveRule, tracerMarker } from "../agent/sensitive-text.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { testServiceIdentity } from "../kernel/test-identity.ts";
import {
  COMMENT_CREATED_AT_MS,
  COMMENT_LOGIN,
  COMMENT_URL,
  commentBytes,
  LISTED_EVENT,
  listedComment,
} from "../repository/github-comment-test-support.ts";
import { WORKER_SERVICE_NAME } from "../worker/contract.ts";
import { MISSION_SERVICE_NAME } from "../mission/contract.ts";
import {
  Consumer,
  INBOUND_EVENT_ID_PREFIX,
  InboundKind,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  IntakeErrorCode,
  intakeOperations,
  ResourceKind,
} from "./contract.ts";
import { insertEvent } from "./event-store.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const PUSH_EVENT = "PushEvent";
const NO_CHANGES = 0;
const AWS_KEY = "AK" + "IA" + "A".repeat(16);
const BODY_PREFIX = "key ";
const BODY_SUFFIX = " end";

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...unusedActionDependencies(),
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const callerOf = (service: string): CallerContext => ({
    identity: testServiceIdentity(service),
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  });
  const describe = async (
    id: string,
    service: string = WORKER_SERVICE_NAME,
  ) => {
    const operation = intakeOperations["inbound.event.describe"];
    return registry.get(operation.id).handler(
      operation.input.parse({
        params: {},
        query: {},
        body: { inbound_event_id: id },
      }),
      callerOf(service),
    );
  };
  const inboundId = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, inboundId, {
      project_id: PROJECT_ID,
      kind: InboundKind.Poll,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: null,
      configuration: {
        resource_kind: ResourceKind.Conversation,
        resource: "octo/widgets",
      },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  let sequence = 0;
  const addEvent = (event: Uint8Array, name: string) =>
    store.transaction((tx) =>
      insertEvent(tx, {
        inbound_id: inboundId,
        event_id: `event-${(sequence += 1)}`,
        event,
        metadata: { event: name },
        created_at: CREATED_AT,
      }),
    );
  const changes = () =>
    Number(
      (
        store.database.prepare("SELECT total_changes() AS total").get() as {
          total: number | bigint;
        }
      ).total,
    );
  return { describe, addEvent, changes };
}

async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  return error;
}

test("a stored listed comment answers the author, the whole body, the URL and the time", async (t) => {
  const h = harness(t);
  const body = "x".repeat(5000);
  const id = h.addEvent(commentBytes(listedComment({ body })), LISTED_EVENT);
  assert.deepEqual(await h.describe(id), {
    author: COMMENT_LOGIN,
    body,
    url: COMMENT_URL,
    occurred_at: COMMENT_CREATED_AT_MS,
  });
});

test("a body with a token answers the marker of its rule in place of the token", async (t) => {
  const h = harness(t);
  const id = h.addEvent(
    commentBytes(listedComment({ body: BODY_PREFIX + AWS_KEY + BODY_SUFFIX })),
    LISTED_EVENT,
  );
  const answer = (await h.describe(id)) as { body: string };
  assert.equal(
    answer.body,
    BODY_PREFIX + tracerMarker(SensitiveRule.AwsAccessKeyId) + BODY_SUFFIX,
  );
});

test("a stored push event answers four null fields", async (t) => {
  const h = harness(t);
  const id = h.addEvent(Buffer.from("{}"), PUSH_EVENT);
  assert.deepEqual(await h.describe(id), {
    author: null,
    body: null,
    url: null,
    occurred_at: null,
  });
});

test("an unknown event answers 404 not_found", async (t) => {
  const h = harness(t);
  const error = await refusal(
    h.describe(createIdentity(INBOUND_EVENT_ID_PREFIX)),
  );
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, IntakeErrorCode.InboundEventNotFound);
});

test("the operation writes no row, releases no custody and calls no platform", async (t) => {
  const h = harness(t);
  const fetched = t.mock.method(globalThis, "fetch");
  const id = h.addEvent(commentBytes(listedComment()), LISTED_EVENT);
  const before = h.changes();
  await h.describe(id);
  assert.equal(h.changes(), before);
  assert.equal(fetched.mock.callCount(), NO_CHANGES);
});

test("a call under the service identity of the Mission Service fails the assertion", async (t) => {
  const h = harness(t);
  const id = h.addEvent(commentBytes(listedComment()), LISTED_EVENT);
  await assert.rejects(
    h.describe(id, MISSION_SERVICE_NAME),
    assert.AssertionError,
  );
});
