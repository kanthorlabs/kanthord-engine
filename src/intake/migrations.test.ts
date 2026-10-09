import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  OutboundOperation,
  OutboundRequestState,
} from "./contract.ts";
import { intakeMigrations } from "./migrations.ts";

const INBOUND_TABLE = "intake_inbound";
const INBOUND_EVENT_TABLE = "intake_inbound_event";
const OUTBOUND_REQUEST_TABLE = "intake_outbound_request";
const INBOUND_EVENT_INDEX = "intake_inbound_event_inbound_event";
const OUTBOUND_REQUEST_INDEX = "intake_outbound_request_operation_key";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ABSENT_INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAX";
const EVENT_ID = "delivery-1";
const REQUEST_KEY = "request-key-1";
const CREATED_AT = 1000;
const UNIQUE_INDEX = 1;
const EQUAL_INBOUNDS = 2;
const UNIQUE_CONSTRAINT = /UNIQUE constraint failed/;
const FOREIGN_KEY_CONSTRAINT = /FOREIGN KEY constraint failed/;

function migratedStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return store;
}

function insertInbound(store: Store, id: string): void {
  store.database
    .prepare(
      `INSERT INTO ${INBOUND_TABLE} (id, project_id, kind, platform, consumer, credential, configuration, checkpoint, created_at) VALUES (?, ?, ?, ?, ?, NULL, '{}', NULL, ?)`,
    )
    .run(
      id,
      PROJECT_ID,
      InboundKind.Webhook,
      InboundPlatform.GitHub,
      Consumer.MissionDeliveryAdmit,
      CREATED_AT,
    );
}

function insertEvent(
  store: Store,
  id: string,
  inboundId: string,
  eventId: string,
): void {
  store.database
    .prepare(
      `INSERT INTO ${INBOUND_EVENT_TABLE} (id, inbound_id, event_id, event, metadata, state, error, created_at) VALUES (?, ?, ?, ?, '{}', ?, NULL, ?)`,
    )
    .run(
      id,
      inboundId,
      eventId,
      new Uint8Array([1]),
      InboundEventState.Pending,
      CREATED_AT,
    );
}

function insertOutboundRequest(store: Store, id: string): void {
  store.database
    .prepare(
      `INSERT INTO ${OUTBOUND_REQUEST_TABLE} (id, project_id, operation, request_key, credential, state, result, error, created_at) VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL, ?)`,
    )
    .run(
      id,
      PROJECT_ID,
      OutboundOperation.GitHubPullRequest,
      REQUEST_KEY,
      OutboundRequestState.Pending,
      CREATED_AT,
    );
}

test("a second inbound event with the same inbound and event id throws", (t) => {
  const store = migratedStore(t);
  insertInbound(store, INBOUND_ID);
  insertEvent(store, "inbound_event_1", INBOUND_ID, EVENT_ID);
  assert.throws(
    () => insertEvent(store, "inbound_event_2", INBOUND_ID, EVENT_ID),
    UNIQUE_CONSTRAINT,
  );
});

test("a second outbound request with the same operation and request key throws", (t) => {
  const store = migratedStore(t);
  insertOutboundRequest(store, "outbound_request_1");
  assert.throws(
    () => insertOutboundRequest(store, "outbound_request_2"),
    UNIQUE_CONSTRAINT,
  );
});

test("two inbounds with equal columns insert", (t) => {
  const store = migratedStore(t);
  insertInbound(store, INBOUND_ID);
  insertInbound(store, OTHER_INBOUND_ID);
  assert.equal(
    store.database
      .prepare(`SELECT COUNT(*) AS count FROM ${INBOUND_TABLE}`)
      .get()?.count,
    EQUAL_INBOUNDS,
  );
});

test("an event of an absent inbound throws", (t) => {
  const store = migratedStore(t);
  assert.throws(
    () => insertEvent(store, "inbound_event_1", ABSENT_INBOUND_ID, EVENT_ID),
    FOREIGN_KEY_CONSTRAINT,
  );
});

test("the intake schema holds no CHECK constraint", (t) => {
  const store = migratedStore(t);
  for (const row of store.database
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
    .all())
    assert.doesNotMatch(String(row.sql), /\bCHECK\b/i);
});

test("the intake indexes are exactly the two unique indexes on their columns", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex%' ORDER BY name",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      { name: INBOUND_EVENT_INDEX, tbl_name: INBOUND_EVENT_TABLE },
      { name: OUTBOUND_REQUEST_INDEX, tbl_name: OUTBOUND_REQUEST_TABLE },
    ],
  );
  for (const [table, index, columns] of [
    [INBOUND_TABLE, undefined, []],
    [INBOUND_EVENT_TABLE, INBOUND_EVENT_INDEX, ["inbound_id", "event_id"]],
    [
      OUTBOUND_REQUEST_TABLE,
      OUTBOUND_REQUEST_INDEX,
      ["operation", "request_key"],
    ],
  ] as const) {
    const indexes = store.database
      .prepare(
        "SELECT name, \"unique\" FROM pragma_index_list(?) WHERE name NOT LIKE 'sqlite_autoindex%'",
      )
      .all(table)
      .map((row) => ({ ...row }));
    if (index === undefined) {
      assert.deepEqual(indexes, []);
      continue;
    }
    assert.deepEqual(indexes, [{ name: index, unique: UNIQUE_INDEX }]);
    assert.deepEqual(
      store.database
        .prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno")
        .all(index)
        .map((row) => row.name),
      columns,
    );
  }
});

test("the intake schema holds the one foreign key of the inbound event", (t) => {
  const store = migratedStore(t);
  const references = [
    INBOUND_TABLE,
    INBOUND_EVENT_TABLE,
    OUTBOUND_REQUEST_TABLE,
  ].flatMap((table) =>
    store.database
      .prepare('SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)')
      .all(table)
      .map((row) => ({ owner: table, ...row })),
  );
  assert.deepEqual(references, [
    {
      owner: INBOUND_EVENT_TABLE,
      table: INBOUND_TABLE,
      from: "inbound_id",
      to: "id",
    },
  ]);
});
