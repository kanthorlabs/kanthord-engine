import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  type IntakeConsumers,
} from "./contract.ts";
import { Dispatcher, nextCandidate, reserve } from "./dispatcher.ts";
import {
  eventRecord,
  insertEvent,
  readEventProjection,
} from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import type { ConsumerCall } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/gated";
const CREATED_AT = 1000;
const CONTENT = '{"action":"closed","number":1}';
const METADATA = { event: "pull_request" };
const IDENTITY: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: INTAKE_SERVICE_NAME,
};
const CLAIM_LIVE = "mission.node.claim_live";
const MATCH_CHANGED = "mission.delivery.match_changed";
const REQUEST_ID = "request_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CONFLICT = 409;
const OK = 200;
const NO_CALLS = 0;
const ONE_CALL = 1;
const THREE_EVENTS = 3;
const EVENT_ENCODING = "base64";

type Answer = () => Promise<OperationResult<unknown>>;

interface Harness {
  store: Store;
  dispatcher: Dispatcher;
  calls: ConsumerCall[];
  answers: Answer[];
  inboundId: string;
}

function migrate(store: Store): void {
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
}

function addInbound(store: Store): string {
  const id = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, id, {
      project_id: PROJECT_ID,
      kind: InboundKind.Webhook,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: null,
      configuration: { resource: RESOURCE },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  return id;
}

function addEvent(store: Store, inboundId: string, eventId: string): string {
  return store.transaction((tx) =>
    insertEvent(tx, {
      inbound_id: inboundId,
      event_id: eventId,
      event: Buffer.from(CONTENT),
      metadata: METADATA,
      created_at: CREATED_AT,
    }),
  );
}

function completed(data: unknown): Answer {
  return () =>
    Promise.resolve({ type: OperationResultType.Completed, status: OK, data });
}

function failure(status: number, code: string, message: string): Answer {
  return () =>
    Promise.resolve({
      type: OperationResultType.Failure,
      status,
      error: {
        error: { code, message, details: null },
        request_id: REQUEST_ID,
      },
    });
}

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

function dispatcherOver(store: Store, consumers: IntakeConsumers): Dispatcher {
  return new Dispatcher({
    store,
    identity: IDENTITY,
    consumers,
    context: background,
  });
}

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  migrate(store);
  return store;
}

function harness(t: TestContext): Harness {
  const store = memoryStore(t);
  const calls: ConsumerCall[] = [];
  const answers: Answer[] = [];
  const dispatcher = dispatcherOver(store, consumersOf(calls, answers));
  return { store, dispatcher, calls, answers, inboundId: addInbound(store) };
}

function recordOf(store: Store, id: string) {
  return store.transaction((tx) => eventRecord(readEventProjection(tx, id)!));
}

async function handOver(h: Harness): Promise<void> {
  h.dispatcher.wake();
  await h.dispatcher.join();
}

test("A reservation adds the oldest pending candidate, and the next candidate skips it", (t) => {
  const store = memoryStore(t);
  const inboundId = addInbound(store);
  const [first, second] = ["d-1", "d-2"]
    .map((d) => addEvent(store, inboundId, d))
    .sort();
  const inFlight = new Set<string>();
  const candidate = store.transaction((tx) => nextCandidate(tx, inFlight));
  assert.equal(candidate, first);
  assert.ok(store.transaction((tx) => reserve(tx, inFlight, first!)));
  assert.deepEqual([...inFlight], [first]);
  assert.equal(
    store.transaction((tx) => nextCandidate(tx, inFlight)),
    second,
  );
});

test("A discard that wins before the reservation starts no handoff", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  const inFlight = new Set<string>();
  const candidate = h.store.transaction((tx) => nextCandidate(tx, inFlight));
  assert.equal(candidate, id);
  h.store.database
    .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
    .run(InboundEventState.Discarded, id);
  assert.equal(
    h.store.transaction((tx) => reserve(tx, inFlight, id)),
    false,
  );
  assert.equal(inFlight.size, NO_CALLS);
  await handOver(h);
  assert.equal(h.calls.length, NO_CALLS);
  assert.equal(recordOf(h.store, id).state, InboundEventState.Discarded);
});

test("Pending events at a start reach the consumer in the order of id, each once", async (t) => {
  const h = harness(t);
  const ids = ["d-1", "d-2", "d-3"].map((d) =>
    addEvent(h.store, h.inboundId, d),
  );
  for (let index = 0; index < THREE_EVENTS; index++)
    h.answers.push(completed({ disposition: "refused", reason: "unmatched" }));
  await handOver(h);
  assert.deepEqual(
    h.calls.map((call) => call.input.inbound_event_id),
    [...ids].sort(),
  );
  for (const id of ids)
    assert.equal(recordOf(h.store, id).state, InboundEventState.Succeeded);
});

test("The handoff input holds the event row and its inbound, under the service identity", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  h.answers.push(completed({ disposition: "duplicate", reason: null }));
  await handOver(h);
  assert.deepEqual(h.calls[0]?.input, {
    inbound_event_id: id,
    project_id: PROJECT_ID,
    platform: InboundPlatform.GitHub,
    resource: RESOURCE,
    event: Buffer.from(CONTENT).toString(EVENT_ENCODING),
    metadata: METADATA,
  });
  assert.deepEqual(h.calls[0]?.options.identity, IDENTITY);
  assert.equal(h.calls[0]?.options.context, background);
  assert.ok(h.calls[0]?.options.idempotencyKey);
  assert.equal(recordOf(h.store, id).error, null);
});

test("Repeated wakes during a handoff start no second handoff of the event", async (t) => {
  const h = harness(t);
  const id = addEvent(h.store, h.inboundId, "d-1");
  const answer = Promise.withResolvers<OperationResult<unknown>>();
  h.answers.push(() => answer.promise);
  h.dispatcher.wake();
  await tick();
  h.dispatcher.wake();
  h.dispatcher.wake();
  await tick();
  assert.equal(h.calls.length, ONE_CALL);
  assert.ok(h.dispatcher.inFlight(id));
  answer.resolve({ type: OperationResultType.Completed, status: OK, data: {} });
  await h.dispatcher.join();
  assert.equal(h.calls.length, ONE_CALL);
  assert.ok(!h.dispatcher.inFlight(id));
  assert.equal(recordOf(h.store, id).state, InboundEventState.Succeeded);
});

test("A 409 claim_live or match_changed answer sets failed with that code", async (t) => {
  const h = harness(t);
  for (const code of [CLAIM_LIVE, MATCH_CHANGED]) {
    const id = addEvent(h.store, h.inboundId, code);
    h.answers.push(failure(CONFLICT, code, "The admission refused."));
    await handOver(h);
    const record = recordOf(h.store, id);
    assert.equal(record.state, InboundEventState.Failed);
    assert.deepEqual(
      record.error?.map((item) => item.code),
      [code],
    );
  }
});
