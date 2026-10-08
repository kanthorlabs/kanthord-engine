import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  OperationRegistry,
  OperationResultType,
  type CallerContext,
  type OperationResult,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INBOUND_EVENT_ID_PREFIX,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundEventStateValue,
  type IntakeConsumers,
} from "./contract.ts";
import { eventState, insertEvent, retryFailedEvent } from "./event-store.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies, type ConsumerCall } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const NOT_FOUND = "intake.inbound.event.not_found";
const STATE_CONFLICT = "intake.inbound.event.state_conflict";
const ERROR_ITEM = {
  code: "indeterminate",
  message: "The consumer answer is indeterminate.",
  created_at: CREATED_AT,
};
const OK = 200;
const ONE_CALL = 1;
const TWO_CALLS = 2;

type Answer = () => Promise<OperationResult<unknown>>;

function consumersOf(
  calls: ConsumerCall[],
  answers: Answer[],
): IntakeConsumers {
  return {
    [Consumer.MissionDeliveryAdmit]: (input, options) => {
      calls.push({ consumer: Consumer.MissionDeliveryAdmit, input, options });
      const answer = answers.shift();
      assert.ok(answer !== undefined, "Each call has a scripted answer.");
      return answer();
    },
  };
}

function completed(): Promise<OperationResult<unknown>> {
  return Promise.resolve({
    type: OperationResultType.Completed,
    status: OK,
    data: { disposition: "refused", reason: "unmatched" },
  });
}

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const calls: ConsumerCall[] = [];
  const answers: Answer[] = [];
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...unusedActionDependencies(),
    consumers: consumersOf(calls, answers),
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const write = (key: "inbound.event.retry") => async (id: string) => {
    const operation = intakeOperations[key];
    return operation.output.parse(
      await registry.get(operation.id).handler(
        operation.input.parse({
          params: { inbound_event_id: id },
          query: {},
          body: null,
        }),
        caller,
      ),
    );
  };
  const inboundId = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, inboundId, {
      project_id: PROJECT_ID,
      kind: InboundKind.Webhook,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: null,
      configuration: { resource: "acme/app" },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  let sequence = 0;
  const addEvent = (
    state: InboundEventStateValue = InboundEventState.Pending,
  ) =>
    store.transaction((tx) => {
      const id = insertEvent(tx, {
        inbound_id: inboundId,
        event_id: `delivery-${(sequence += 1)}`,
        event: Buffer.from("{}"),
        metadata: { event: "push" },
        created_at: CREATED_AT,
      });
      const error =
        state === InboundEventState.Failed
          ? JSON.stringify([ERROR_ITEM])
          : null;
      tx.database
        .prepare(
          "UPDATE intake_inbound_event SET state = ?, error = ? WHERE id = ?",
        )
        .run(state, error, id);
      return id;
    });
  const stateOf = (id: string) => store.transaction((tx) => eventState(tx, id));
  return {
    store,
    intake,
    calls,
    answers,
    addEvent,
    stateOf,
    retry: write("inbound.event.retry"),
  };
}

function refusal(status: number, code: string) {
  return (error: unknown) =>
    error instanceof OperationError &&
    error.status === status &&
    error.code === code;
}

test("A retry turns a failed event to pending and keeps its error", async (t) => {
  const h = harness(t);
  const id = h.addEvent(InboundEventState.Failed);
  const event = await h.retry(id);
  assert.equal(event.id, id);
  assert.equal(event.state, InboundEventState.Pending);
  assert.deepEqual(event.error, [ERROR_ITEM]);
  assert.equal(h.stateOf(id), InboundEventState.Pending);
});

test("A retry of a pending event answers its current state", async (t) => {
  const h = harness(t);
  const id = h.addEvent();
  const event = await h.retry(id);
  assert.equal(event.state, InboundEventState.Pending);
  assert.equal(event.error, null);
});

test("A retry of a succeeded or a discarded event answers 409 state_conflict", async (t) => {
  const h = harness(t);
  for (const state of [
    InboundEventState.Succeeded,
    InboundEventState.Discarded,
  ]) {
    const id = h.addEvent(state);
    await assert.rejects(
      h.retry(id),
      refusal(HttpStatus.Conflict, STATE_CONFLICT),
    );
    assert.equal(h.stateOf(id), state);
  }
});

test("A retry of an absent event answers 404 not_found", async (t) => {
  const h = harness(t);
  const absent = createIdentity(INBOUND_EVENT_ID_PREFIX);
  await assert.rejects(
    h.retry(absent),
    refusal(HttpStatus.NotFound, NOT_FOUND),
  );
});

test("A retried event is handed over once more when the dispatcher wakes", async (t) => {
  const h = harness(t);
  const id = h.addEvent();
  h.answers.push(
    () => Promise.resolve({ type: OperationResultType.Indeterminate }),
    completed,
  );
  h.intake.dispatcher.wake();
  await h.intake.dispatcher.join();
  assert.equal(h.stateOf(id), InboundEventState.Failed);
  assert.equal(h.calls.length, ONE_CALL);
  assert.equal((await h.retry(id)).state, InboundEventState.Pending);
  h.intake.dispatcher.wake();
  await h.intake.dispatcher.join();
  assert.equal(h.calls.length, TWO_CALLS);
  assert.equal(h.calls[ONE_CALL]?.input.inbound_event_id, id);
  assert.equal(h.stateOf(id), InboundEventState.Succeeded);
});

test("A retry write from a stale state changes no row", (t) => {
  const h = harness(t);
  const pending = h.addEvent();
  h.store.transaction((tx) => {
    assert.equal(retryFailedEvent(tx, pending), false);
  });
  assert.equal(h.stateOf(pending), InboundEventState.Pending);
});
