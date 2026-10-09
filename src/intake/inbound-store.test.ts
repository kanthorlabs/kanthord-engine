import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { identitySchema } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INBOUND_ID_PREFIX,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
} from "./contract.ts";
import {
  allocateInboundId,
  deleteInbound,
  inboundRecord,
  insertInbound,
  pendingEventCount,
  pollInboundIds,
  readInbound,
  writeCheckpoint,
  type NewInbound,
} from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 1000;
const RESOURCE = "acme/app";
const CHECKPOINT = { cursor: "abc" };
const KEPT_EVENTS = 2;
const PENDING_EVENTS = 2;
const EVENTS_AFTER_DELETE = 0;
const PENDING_AFTER_SETTLE = 0;

function migratedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return store;
}

function newInbound(
  configuration: unknown = { resource: RESOURCE },
): NewInbound {
  return {
    project_id: PROJECT_ID,
    kind: InboundKind.Webhook,
    platform: InboundPlatform.GitHub,
    consumer: Consumer.MissionDeliveryAdmit,
    credential: null,
    configuration,
    checkpoint: null,
    created_at: CREATED_AT,
  };
}

function insert(store: Store, row: NewInbound = newInbound()): string {
  const id = allocateInboundId();
  store.transaction((tx) => insertInbound(tx, id, row));
  return id;
}

function insertEvent(
  store: Store,
  inboundId: string,
  eventId: string,
  state: string,
): void {
  store.transaction((tx) => {
    tx.database
      .prepare(
        `INSERT INTO intake_inbound_event
      (id, inbound_id, event_id, event, metadata, state, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        `inbound_event_${eventId}`,
        inboundId,
        eventId,
        Buffer.from("{}"),
        "{}",
        state,
        CREATED_AT,
      );
  });
}

test("an allocated identity is an inbound identity", () => {
  assert.ok(
    identitySchema(INBOUND_ID_PREFIX).safeParse(allocateInboundId()).success,
  );
});

test("the projection answers the row with parsed columns and no secret", (t) => {
  const store = migratedStore(t);
  const id = insert(store, { ...newInbound(), checkpoint: CHECKPOINT });
  const record = store.transaction((tx) => inboundRecord(readInbound(tx, id)!));
  assert.deepEqual(record, {
    id,
    project_id: PROJECT_ID,
    kind: InboundKind.Webhook,
    platform: InboundPlatform.GitHub,
    consumer: Consumer.MissionDeliveryAdmit,
    credential: null,
    configuration: { resource: RESOURCE },
    checkpoint: CHECKPOINT,
    created_at: CREATED_AT,
  });
  assert.equal("secret" in record, false);
});

test("a configuration with an extra field or a bad resource refuses", (t) => {
  const store = migratedStore(t);
  for (const configuration of [
    { resource: RESOURCE, extra: 1 },
    { resource: "acme" },
  ])
    assert.throws(() => insert(store, newInbound(configuration)));
  assert.equal(
    store.transaction((tx) => readInbound(tx, "missing")),
    null,
  );
});

test("two inserts with one configuration both succeed", (t) => {
  const store = migratedStore(t);
  const first = insert(store);
  const second = insert(store);
  assert.notEqual(first, second);
});

test("deleteInbound removes the events and the row", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  insertEvent(store, id, "e1", InboundEventState.Succeeded);
  insertEvent(store, id, "e2", InboundEventState.Failed);
  assert.equal(
    store.transaction((tx) => pendingEventCount(tx, id)),
    PENDING_AFTER_SETTLE,
  );
  assert.equal(
    store.transaction((tx) => deleteInbound(tx, id)),
    true,
  );
  assert.equal(
    store.transaction((tx) => readInbound(tx, id)),
    null,
  );
  const left = store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT COUNT(*) AS total FROM intake_inbound_event")
        .get() as {
        total: number;
      },
  );
  assert.equal(left.total, EVENTS_AFTER_DELETE);
});

test("deleteInbound refuses an inbound with a pending event and keeps the row and the events", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  insertEvent(store, id, "e1", InboundEventState.Pending);
  insertEvent(store, id, "e2", InboundEventState.Succeeded);
  assert.throws(
    () => store.transaction((tx) => deleteInbound(tx, id)),
    assert.AssertionError,
  );
  assert.notEqual(
    store.transaction((tx) => readInbound(tx, id)),
    null,
  );
  const left = store.transaction(
    (tx) =>
      tx.database
        .prepare(
          "SELECT COUNT(*) AS total FROM intake_inbound_event WHERE inbound_id = ?",
        )
        .get(id) as {
        total: number;
      },
  );
  assert.equal(left.total, KEPT_EVENTS);
});

test("pendingEventCount counts pending events alone", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  insertEvent(store, id, "e1", InboundEventState.Pending);
  insertEvent(store, id, "e2", InboundEventState.Pending);
  insertEvent(store, id, "e3", InboundEventState.Succeeded);
  assert.equal(
    store.transaction((tx) => pendingEventCount(tx, id)),
    PENDING_EVENTS,
  );
});

test("a checkpoint write replaces the stored checkpoint of one row", (t) => {
  const store = migratedStore(t);
  const id = insert(store);
  const text = JSON.stringify(CHECKPOINT);
  store.transaction((tx) => writeCheckpoint(tx, id, text));
  assert.equal(
    store.transaction((tx) => readInbound(tx, id)!.checkpoint),
    text,
  );
  assert.throws(() =>
    store.transaction((tx) => writeCheckpoint(tx, allocateInboundId(), text)),
  );
});

test("the poll inbound list answers only the poll identities in order", (t) => {
  const store = migratedStore(t);
  insert(store);
  const polls = [
    insert(store, { ...newInbound(), kind: InboundKind.Poll }),
    insert(store, { ...newInbound(), kind: InboundKind.Poll }),
  ].sort();
  assert.deepEqual(
    store.transaction((tx) => pollInboundIds(tx)),
    polls,
  );
});
