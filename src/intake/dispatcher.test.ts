import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
} from "./contract.ts";
import { nextCandidate, reserve } from "./dispatcher.ts";
import { insertEvent } from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/gated";
const CREATED_AT = 1000;
const CONTENT = '{"action":"closed","number":1}';
const METADATA = { event: "pull_request" };
const NO_CALLS = 0;

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

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  migrate(store);
  return store;
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

test("A discard that wins before the reservation starts no handoff", (t) => {
  const store = memoryStore(t);
  const id = addEvent(store, addInbound(store), "d-1");
  const inFlight = new Set<string>();
  const candidate = store.transaction((tx) => nextCandidate(tx, inFlight));
  assert.equal(candidate, id);
  store.database
    .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
    .run(InboundEventState.Discarded, id);
  assert.equal(
    store.transaction((tx) => reserve(tx, inFlight, id)),
    false,
  );
  assert.equal(inFlight.size, NO_CALLS);
});
