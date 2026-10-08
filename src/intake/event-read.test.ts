import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  Consumer,
  INBOUND_EVENT_ID_PREFIX,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  intakeOperations,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { insertEvent } from "./event-store.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const NOT_FOUND = "intake.inbound.event.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const PAGE_SIZE = 2;
const FIRST_ROW = 0;
const SECOND_ROW = 1;
const NO_ROWS = 0;
const PROJECTION_KEYS = [
  "created_at",
  "error",
  "event_id",
  "id",
  "inbound_id",
  "metadata",
  "state",
];

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
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
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const list = async (query: Record<string, unknown> = {}) => {
    const operation = intakeOperations["inbound.event.list"];
    return operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query, body: null }),
          caller,
        ),
    );
  };
  const get = async (id: string) => {
    const operation = intakeOperations["inbound.event.get"];
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
  const addInbound = () => {
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
  };
  let sequence = 0;
  const addEvent = (inboundId: string) =>
    store.transaction((tx) =>
      insertEvent(tx, {
        inbound_id: inboundId,
        event_id: `delivery-${(sequence += 1)}`,
        event: Buffer.from("{}"),
        metadata: { event: "push" },
        created_at: CREATED_AT,
      }),
    );
  const setState = (id: string, state: string) =>
    store.transaction((tx) =>
      tx.database
        .prepare("UPDATE intake_inbound_event SET state = ? WHERE id = ?")
        .run(state, id),
    );
  return { store, list, get, addInbound, addEvent, setState };
}

async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  return error;
}

test("an empty list answers no items and no cursor", async (t) => {
  const h = harness(t);
  assert.deepEqual(await h.list(), { items: [], next_cursor: null });
});

test("the list combines the inbound and state filters with AND", async (t) => {
  const h = harness(t);
  const first = h.addInbound();
  const second = h.addInbound();
  const target = h.addEvent(first);
  const settled = h.addEvent(first);
  h.addEvent(second);
  h.setState(settled, InboundEventState.Succeeded);
  const ids = async (query: Record<string, unknown>) =>
    (await h.list(query)).items.map((item) => item.id);
  assert.equal((await ids({ inbound_id: first })).length, PAGE_SIZE);
  assert.equal(
    (await ids({ state: InboundEventState.Pending })).length,
    PAGE_SIZE,
  );
  assert.deepEqual(
    await ids({ inbound_id: first, state: InboundEventState.Pending }),
    [target],
  );
  assert.deepEqual(
    await ids({ inbound_id: first, state: InboundEventState.Succeeded }),
    [settled],
  );
});

test("a list item is the projection with no event content", async (t) => {
  const h = harness(t);
  h.addEvent(h.addInbound());
  const [item] = (await h.list()).items;
  assert.deepEqual(Object.keys(item!).sort(), PROJECTION_KEYS);
});

function recordReadRows(t: TestContext, store: Store): object[] {
  const rows: object[] = [];
  const prepare = store.database.prepare.bind(store.database);
  t.mock.method(store.database, "prepare", (sql: string) => {
    const statement = prepare(sql);
    const all = statement.all.bind(statement);
    const get = statement.get.bind(statement);
    return Object.assign(statement, {
      all: (...values: Parameters<typeof all>) => {
        const found = all(...values);
        rows.push(...found);
        return found;
      },
      get: (...values: Parameters<typeof get>) => {
        const found = get(...values);
        if (found !== undefined) rows.push(found);
        return found;
      },
    });
  });
  return rows;
}

test("the list and the get read no event content", async (t) => {
  const h = harness(t);
  const id = h.addEvent(h.addInbound());
  const rows = recordReadRows(t, h.store);
  await h.list();
  await h.get(id);
  assert.ok(rows.length > NO_ROWS);
  assert.equal(
    rows.some((row) => "event" in row),
    false,
  );
});

test("a page of two answers the newest first with a cursor to the rest", async (t) => {
  const h = harness(t);
  const inbound = h.addInbound();
  const ids = [h.addEvent(inbound), h.addEvent(inbound), h.addEvent(inbound)];
  const first = await h.list({ limit: PAGE_SIZE });
  assert.equal(first.items.length, PAGE_SIZE);
  assert.ok(first.items[FIRST_ROW]!.id > first.items[SECOND_ROW]!.id);
  assert.ok(first.next_cursor);
  const second = await h.list({ limit: PAGE_SIZE, cursor: first.next_cursor });
  assert.equal(second.items.length, SECOND_ROW);
  assert.equal(second.next_cursor, null);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    [...ids].sort().reverse(),
  );
});

test("a malformed cursor answers 400 cursor_invalid", async (t) => {
  const h = harness(t);
  for (const cursor of [
    "!!",
    Buffer.from("junk").toString("base64url"),
    Buffer.from(createIdentity("inbound")).toString("base64url"),
  ]) {
    const error = await refusal(h.list({ cursor }));
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, CURSOR_INVALID);
  }
});

test("a get answers the projection of the event", async (t) => {
  const h = harness(t);
  const inbound = h.addInbound();
  const id = h.addEvent(inbound);
  const record = await h.get(id);
  assert.equal(record.id, id);
  assert.equal(record.inbound_id, inbound);
  assert.equal(record.state, InboundEventState.Pending);
  assert.deepEqual(Object.keys(record).sort(), PROJECTION_KEYS);
});

test("an unknown event identity answers 404", async (t) => {
  const h = harness(t);
  const error = await refusal(h.get(createIdentity(INBOUND_EVENT_ID_PREFIX)));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
});
