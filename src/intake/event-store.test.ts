import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { identitySchema } from "../kernel/identity.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INBOUND_EVENT_ID_PREFIX,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
} from "./contract.ts";
import {
  eventRecord,
  eventState,
  failEvent,
  findEvent,
  insertEvent,
  oldestPendingEvent,
  pendingCount,
  readEvent,
  readEventProjection,
  succeedEvent,
} from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 1000;
const EVENT_ID = "delivery-1";
const CONTENT = '{"ref":"refs/heads/main"}';
const METADATA = { event: "push" };
const PENDING_IN_EMPTY_STORE = 0;
const PENDING_AFTER_DUPLICATE = 1;
const STORED_METADATA = '{"event":"push"}';
const PENDING_ACROSS_INBOUNDS = 2;

function migratedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return store;
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
      configuration: { resource: "acme/app" },
      checkpoint: null,
      created_at: CREATED_AT,
    }),
  );
  return id;
}

function addEvent(store: Store, inboundId: string, eventId = EVENT_ID): string {
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

test("an insert answers an event identity and stores a pending row", (t) => {
  const store = migratedStore(t);
  const inboundId = addInbound(store);
  const id = addEvent(store, inboundId);
  assert.ok(identitySchema(INBOUND_EVENT_ID_PREFIX).safeParse(id).success);
  const row = store.transaction((tx) => readEvent(tx, id)!);
  assert.equal(row.state, InboundEventState.Pending);
  assert.equal(row.error, null);
  assert.equal(row.metadata, STORED_METADATA);
  assert.equal(Buffer.from(row.event).toString(), CONTENT);
});

test("findEvent finds a stored inbound and event identity pair", (t) => {
  const store = migratedStore(t);
  const inboundId = addInbound(store);
  const id = addEvent(store, inboundId);
  const found = store.transaction((tx) => findEvent(tx, inboundId, EVENT_ID));
  assert.equal(found, id);
  assert.equal(
    store.transaction((tx) => findEvent(tx, inboundId, "other")),
    null,
  );
});

test("the projection read answers every column except the event content", (t) => {
  const store = migratedStore(t);
  const id = addEvent(store, addInbound(store));
  const row = store.transaction((tx) => readEventProjection(tx, id)!);
  assert.equal(row.id, id);
  assert.equal("event" in row, false);
  assert.equal(
    store.transaction((tx) =>
      readEventProjection(tx, `${INBOUND_EVENT_ID_PREFIX}_absent`),
    ),
    null,
  );
});

test("a second insert of one pair throws on the unique index", (t) => {
  const store = migratedStore(t);
  const inboundId = addInbound(store);
  addEvent(store, inboundId);
  assert.throws(() => addEvent(store, inboundId), /UNIQUE/);
  assert.equal(
    store.transaction((tx) => pendingCount(tx)),
    PENDING_AFTER_DUPLICATE,
  );
});

test("one event identity in two inbounds inserts twice", (t) => {
  const store = migratedStore(t);
  const first = addEvent(store, addInbound(store));
  const second = addEvent(store, addInbound(store));
  assert.notEqual(first, second);
  assert.equal(
    store.transaction((tx) => pendingCount(tx)),
    PENDING_ACROSS_INBOUNDS,
  );
});

test("the pending count spans every inbound and skips other states", (t) => {
  const store = migratedStore(t);
  assert.equal(
    store.transaction((tx) => pendingCount(tx)),
    PENDING_IN_EMPTY_STORE,
  );
  const first = addInbound(store);
  addEvent(store, first, "a");
  addEvent(store, addInbound(store), "b");
  const settled = addEvent(store, first, "c");
  store.transaction((tx) =>
    tx.database
      .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
      .run(InboundEventState.Succeeded, settled),
  );
  assert.equal(
    store.transaction((tx) => pendingCount(tx)),
    PENDING_ACROSS_INBOUNDS,
  );
});

test("the projection holds no content and keeps the stored error", (t) => {
  const store = migratedStore(t);
  const inboundId = addInbound(store);
  const id = addEvent(store, inboundId);
  const record = store.transaction((tx) => eventRecord(readEvent(tx, id)!));
  assert.deepEqual(record, {
    id,
    inbound_id: inboundId,
    event_id: EVENT_ID,
    metadata: METADATA,
    state: InboundEventState.Pending,
    error: null,
    created_at: CREATED_AT,
  });
  assert.equal("event" in record, false);
  const error = [{ code: "indeterminate", message: "m", created_at: 5 }];
  store.transaction((tx) =>
    tx.database
      .prepare("UPDATE intake_inbound_event SET error = ? WHERE id = ?")
      .run(JSON.stringify(error), id),
  );
  assert.deepEqual(
    store.transaction((tx) => eventRecord(readEvent(tx, id)!)).error,
    error,
  );
});

function setState(store: Store, id: string, state: string): void {
  store.transaction((tx) =>
    tx.database
      .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
      .run(state, id),
  );
}

test("the oldest pending read orders by id and skips excluded and settled rows", (t) => {
  const store = migratedStore(t);
  const inboundId = addInbound(store);
  const ids = ["a", "b", "c"].map((eventId) =>
    addEvent(store, inboundId, eventId),
  );
  const [first, second, third] = [...ids].sort();
  const oldest = (excluded: string[]) =>
    store.transaction((tx) => oldestPendingEvent(tx, new Set(excluded)));
  assert.equal(oldest([]), first);
  assert.equal(oldest([first!]), second);
  setState(store, second!, InboundEventState.Failed);
  assert.equal(oldest([first!]), third);
  assert.equal(oldest([first!, third!]), null);
});

test("the state read answers the state of a row and null for an absent row", (t) => {
  const store = migratedStore(t);
  const id = addEvent(store, addInbound(store));
  assert.equal(
    store.transaction((tx) => eventState(tx, id)),
    InboundEventState.Pending,
  );
  assert.equal(
    store.transaction((tx) => eventState(tx, `${INBOUND_EVENT_ID_PREFIX}_x`)),
    null,
  );
});

test("the succeeded write changes a pending row only", (t) => {
  const store = migratedStore(t);
  const id = addEvent(store, addInbound(store));
  assert.equal(
    store.transaction((tx) => succeedEvent(tx, id)),
    true,
  );
  assert.equal(
    store.transaction((tx) => eventState(tx, id)),
    InboundEventState.Succeeded,
  );
  assert.equal(
    store.transaction((tx) => succeedEvent(tx, id)),
    false,
  );
});

test("the failed write appends an error item to a pending row only", (t) => {
  const store = migratedStore(t);
  const id = addEvent(store, addInbound(store));
  const item = { code: "indeterminate", message: "m", created_at: 5 };
  assert.equal(
    store.transaction((tx) => failEvent(tx, id, item)),
    true,
  );
  const record = store.transaction((tx) => eventRecord(readEvent(tx, id)!));
  assert.equal(record.state, InboundEventState.Failed);
  assert.deepEqual(record.error, [item]);
  assert.equal(
    store.transaction((tx) => failEvent(tx, id, item)),
    false,
  );
  setState(store, id, InboundEventState.Pending);
  assert.equal(
    store.transaction((tx) => failEvent(tx, id, { ...item, created_at: 6 })),
    true,
  );
  assert.deepEqual(
    store.transaction((tx) => eventRecord(readEvent(tx, id)!)).error,
    [item, { ...item, created_at: 6 }],
  );
});
