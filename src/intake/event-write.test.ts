import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
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
  DELETE_IDS_MAX,
  INBOUND_EVENT_ID_PREFIX,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundEventStateValue,
} from "./contract.ts";
import {
  discardEventFrom,
  eventState,
  insertEvent,
  retryFailedEvent,
} from "./event-store.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  scriptedConsumers,
  unusedActionDependencies,
  type ConsumerAnswer,
  type ConsumerCall,
} from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const NOT_FOUND = "intake.inbound.event.not_found";
const IN_FLIGHT = "intake.inbound.event.in_flight";
const STATE_CONFLICT = "intake.inbound.event.state_conflict";
const FILTER_INVALID = "intake.inbound.event.filter_invalid";
const RANGE_SIZE = 7;
const RANGE_DELETED = 3;
const ERROR_ITEM = {
  code: "indeterminate",
  message: "The consumer answer is indeterminate.",
  created_at: CREATED_AT,
};
const HANDOFFS_AFTER_DISCARD = 0;
const HANDOFFS_PER_EVENT = 1;
const RETRY_HANDOFF_INDEX = 1;
const HANDOFFS_AFTER_RETRY = 2;
const WAIT_TICKS = 1000;

function completed(): Promise<OperationResult<unknown>> {
  return Promise.resolve({
    type: OperationResultType.Completed,
    status: HttpStatus.OK,
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
  const answers: ConsumerAnswer[] = [];
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...unusedActionDependencies(),
    consumers: scriptedConsumers(calls, answers),
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const write =
    (key: "inbound.event.retry" | "inbound.event.discard") =>
    async (id: string) => {
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
  const setState = (id: string, state: InboundEventStateValue) =>
    store.transaction((tx) =>
      tx.database
        .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
        .run(state, id),
    );
  const deleteEvents = async (body: unknown) => {
    const operation = intakeOperations["inbound.event.delete"];
    return operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query: {}, body }),
          caller,
        ),
    );
  };
  return {
    store,
    intake,
    calls,
    answers,
    addEvent,
    stateOf,
    setState,
    deleteEvents,
    retry: write("inbound.event.retry"),
    discard: write("inbound.event.discard"),
  };
}

function refusal(status: number, code: string) {
  return (error: unknown) =>
    error instanceof OperationError &&
    error.status === status &&
    error.code === code;
}

async function untilCalls(calls: ConsumerCall[], count: number) {
  for (let step = 0; step < WAIT_TICKS && calls.length < count; step++)
    await tick();
  assert.equal(calls.length, count);
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

test("A retry and a discard of an absent event answer 404 not_found", async (t) => {
  const h = harness(t);
  const absent = createIdentity(INBOUND_EVENT_ID_PREFIX);
  await assert.rejects(
    h.retry(absent),
    refusal(HttpStatus.NotFound, NOT_FOUND),
  );
  await assert.rejects(
    h.discard(absent),
    refusal(HttpStatus.NotFound, NOT_FOUND),
  );
});

test("A discard turns a pending or a failed event to discarded", async (t) => {
  const h = harness(t);
  for (const state of [InboundEventState.Pending, InboundEventState.Failed]) {
    const id = h.addEvent(state);
    const event = await h.discard(id);
    assert.equal(event.state, InboundEventState.Discarded);
    assert.equal(h.stateOf(id), InboundEventState.Discarded);
  }
});

test("A discard of a succeeded or a discarded event answers 409 state_conflict", async (t) => {
  const h = harness(t);
  for (const state of [
    InboundEventState.Succeeded,
    InboundEventState.Discarded,
  ]) {
    const id = h.addEvent(state);
    await assert.rejects(
      h.discard(id),
      refusal(HttpStatus.Conflict, STATE_CONFLICT),
    );
    assert.equal(h.stateOf(id), state);
  }
});

test("A discard after the reservation of a handoff answers 409 in_flight, and the handoff writes its state", async (t) => {
  const h = harness(t);
  const id = h.addEvent();
  let release: () => void = () => assert.fail("The handoff is not held.");
  h.answers.push(
    () =>
      new Promise((resolve) => {
        release = () => resolve(completed());
      }),
  );
  h.intake.dispatcher.wake();
  await untilCalls(h.calls, HANDOFFS_PER_EVENT);
  assert.equal(h.intake.dispatcher.inFlight(id), true);
  await assert.rejects(h.discard(id), refusal(HttpStatus.Conflict, IN_FLIGHT));
  assert.equal(h.stateOf(id), InboundEventState.Pending);
  release();
  await h.intake.dispatcher.join();
  assert.equal(h.stateOf(id), InboundEventState.Succeeded);
  assert.equal(h.intake.dispatcher.inFlight(id), false);
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
  assert.equal(h.calls.length, HANDOFFS_PER_EVENT);
  assert.equal((await h.retry(id)).state, InboundEventState.Pending);
  h.intake.dispatcher.wake();
  await h.intake.dispatcher.join();
  assert.equal(h.calls.length, HANDOFFS_AFTER_RETRY);
  assert.equal(h.calls[RETRY_HANDOFF_INDEX]?.input.inbound_event_id, id);
  assert.equal(h.stateOf(id), InboundEventState.Succeeded);
});

test("A retry on a started service hands the event over once more through the live wake", async (t) => {
  const h = harness(t);
  assert.equal(await h.intake.start(), null);
  const id = h.addEvent(InboundEventState.Failed);
  h.answers.push(completed);
  assert.equal((await h.retry(id)).state, InboundEventState.Pending);
  await h.intake.dispatcher.join();
  assert.equal(h.calls.length, HANDOFFS_PER_EVENT);
  assert.equal(h.calls[0]?.input.inbound_event_id, id);
  assert.equal(h.stateOf(id), InboundEventState.Succeeded);
  assert.equal(await h.intake.stop(), null);
});

test("A discarded event is handed over by no later wake", async (t) => {
  const h = harness(t);
  const id = h.addEvent(InboundEventState.Failed);
  await h.discard(id);
  h.intake.dispatcher.wake();
  await h.intake.dispatcher.join();
  assert.equal(h.calls.length, HANDOFFS_AFTER_DISCARD);
  assert.equal(h.stateOf(id), InboundEventState.Discarded);
});

test("A retry or a discard write from a stale state changes no row", (t) => {
  const h = harness(t);
  const pending = h.addEvent();
  const succeeded = h.addEvent(InboundEventState.Succeeded);
  h.store.transaction((tx) => {
    assert.equal(retryFailedEvent(tx, pending), false);
    assert.equal(
      discardEventFrom(tx, succeeded, InboundEventState.Failed),
      false,
    );
  });
  assert.equal(h.stateOf(pending), InboundEventState.Pending);
  assert.equal(h.stateOf(succeeded), InboundEventState.Succeeded);
});

test("A delete without a filter, with both filters or with the state pending answers 400 filter_invalid", async (t) => {
  const h = harness(t);
  const id = h.addEvent(InboundEventState.Failed);
  const bodies = [
    {},
    { state: InboundEventState.Failed, from: id },
    { from: id, to: id },
    { state: InboundEventState.Failed, from: id, to: id, ids: [id] },
    { state: InboundEventState.Failed, ids: [id] },
    { state: InboundEventState.Pending, from: id, to: id },
  ];
  for (const body of bodies)
    await assert.rejects(
      h.deleteEvents(body),
      refusal(HttpStatus.BadRequest, FILTER_INVALID),
    );
  assert.equal(h.stateOf(id), InboundEventState.Failed);
});

test("A delete list that names a succeeded and a pending event answers 409 state_conflict and deletes neither", async (t) => {
  const h = harness(t);
  const succeeded = h.addEvent(InboundEventState.Succeeded);
  const pending = h.addEvent();
  await assert.rejects(
    h.deleteEvents({ ids: [succeeded, pending] }),
    refusal(HttpStatus.Conflict, STATE_CONFLICT),
  );
  assert.equal(h.stateOf(succeeded), InboundEventState.Succeeded);
  assert.equal(h.stateOf(pending), InboundEventState.Pending);
});

test("A delete list removes the named settled events and answers their count", async (t) => {
  const h = harness(t);
  const named = [
    h.addEvent(InboundEventState.Succeeded),
    h.addEvent(InboundEventState.Failed),
    h.addEvent(InboundEventState.Discarded),
  ];
  const kept = h.addEvent(InboundEventState.Succeeded);
  const absent = createIdentity(INBOUND_EVENT_ID_PREFIX);
  const answer = await h.deleteEvents({ ids: [...named, absent] });
  assert.deepEqual(answer, { count: named.length });
  for (const id of named) assert.equal(h.stateOf(id), null);
  assert.equal(h.stateOf(kept), InboundEventState.Succeeded);
});

test("Each state filter over a range of mixed states removes that state alone, both bounds included", async (t) => {
  for (const state of [
    InboundEventState.Succeeded,
    InboundEventState.Failed,
    InboundEventState.Discarded,
  ]) {
    const h = harness(t);
    const ids = Array.from({ length: RANGE_SIZE }, () => h.addEvent()).sort();
    const [first, pending, succeeded, failed, discarded, last, outside] = ids;
    assert.ok(first && pending && succeeded && failed && discarded);
    assert.ok(last && outside);
    const states = new Map<string, InboundEventStateValue>([
      [first, state],
      [pending, InboundEventState.Pending],
      [succeeded, InboundEventState.Succeeded],
      [failed, InboundEventState.Failed],
      [discarded, InboundEventState.Discarded],
      [last, state],
      [outside, state],
    ]);
    for (const [id, value] of states) h.setState(id, value);
    const answer = await h.deleteEvents({ state, from: first, to: last });
    assert.deepEqual(answer, { count: RANGE_DELETED });
    for (const [id, value] of states) {
      const removed: boolean = id !== outside && value === state;
      assert.equal(h.stateOf(id), removed ? null : value);
    }
  }
});

test("A range that matches more than the identity bound answers 400 filter_invalid and deletes nothing; a range at the bound passes", async (t) => {
  const h = harness(t);
  const ids = Array.from({ length: DELETE_IDS_MAX + 1 }, () =>
    h.addEvent(InboundEventState.Succeeded),
  ).sort();
  const [first] = ids;
  const atBound = ids[DELETE_IDS_MAX - 1];
  const last = ids[DELETE_IDS_MAX];
  assert.ok(first && atBound && last);
  const state = InboundEventState.Succeeded;
  await assert.rejects(
    h.deleteEvents({ state, from: first, to: last }),
    refusal(HttpStatus.BadRequest, FILTER_INVALID),
  );
  for (const id of ids) assert.equal(h.stateOf(id), state);
  const answer = await h.deleteEvents({ state, from: first, to: atBound });
  assert.deepEqual(answer, { count: DELETE_IDS_MAX });
  for (const id of ids) assert.equal(h.stateOf(id), id === last ? state : null);
});
