import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  ResourceKind,
} from "./contract.ts";
import {
  eventRecord,
  eventState,
  failEvent,
  insertEvent,
  oldestPendingEvent,
  pendingCount,
  readEvent,
  succeedEvent,
} from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 1000;
const EVENT_ID = "delivery-1";
const CONTENT = '{"ref":"refs/heads/main"}';
const METADATA = { event: "push" };
const PENDING_AFTER_DUPLICATE = 1;

function migratedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
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
      configuration: {
        resource_kind: ResourceKind.Repository,
        resource: "acme/app",
      },
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
