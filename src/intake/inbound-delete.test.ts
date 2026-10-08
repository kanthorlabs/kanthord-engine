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
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundEventStateValue,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/repo";
const CREATED_AT = 100;
const NOT_FOUND = "intake.inbound.not_found";
const EVENTS_PENDING = "intake.inbound.events_pending";
const NO_ROWS = 0;
const ONE_ROW = 1;
const TWO_ROWS = 2;
const NO_CALLS = 0;
const ONE_CALL = 1;

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
  const removed = t.mock.method(intake, "inboundRemoved");
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const remove = async (id: string) => {
    const operation = intakeOperations["inbound.delete"];
    return operation.output.parse(
      await registry.get(operation.id).handler(
        operation.input.parse({
          params: { inbound_id: id },
          query: {},
          body: null,
        }),
        caller,
      ),
    );
  };
  const insert = () =>
    store.transaction((tx) => {
      const id = allocateInboundId();
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Webhook,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: null,
        configuration: { resource: RESOURCE },
        checkpoint: null,
        created_at: CREATED_AT,
      });
      return id;
    });
  const insertEvent = (
    inboundId: string,
    eventId: string,
    state: InboundEventStateValue,
  ) =>
    store.transaction((tx) => {
      tx.database
        .prepare(
          `INSERT INTO intake_inbound_event
        (id, inbound_id, event_id, event, metadata, state, error, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          createIdentity("inbound_event"),
          inboundId,
          eventId,
          Buffer.from("{}"),
          "{}",
          state,
          CREATED_AT,
        );
    });
  const count = (sql: string, id: string) =>
    store.transaction((tx) =>
      Number(
        (tx.database.prepare(sql).get(id) as { total: number | bigint }).total,
      ),
    );
  const inboundRows = (id: string) =>
    count("SELECT COUNT(*) AS total FROM intake_inbound WHERE id = ?", id);
  const eventRows = (id: string) =>
    count(
      "SELECT COUNT(*) AS total FROM intake_inbound_event WHERE inbound_id = ?",
      id,
    );
  return { remove, insert, insertEvent, inboundRows, eventRows, removed };
}

async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  return error;
}

test("a delete removes the inbound and its settled events and notifies the poll loop", async (t) => {
  const h = harness(t);
  const id = h.insert();
  const other = h.insert();
  h.insertEvent(id, "e1", InboundEventState.Succeeded);
  h.insertEvent(id, "e2", InboundEventState.Failed);
  h.insertEvent(id, "e3", InboundEventState.Discarded);
  h.insertEvent(other, "e1", InboundEventState.Succeeded);
  assert.equal(await h.remove(id), null);
  assert.equal(h.inboundRows(id), NO_ROWS);
  assert.equal(h.eventRows(id), NO_ROWS);
  assert.equal(h.inboundRows(other), ONE_ROW);
  assert.equal(h.eventRows(other), ONE_ROW);
  assert.equal(h.removed.mock.callCount(), ONE_CALL);
  assert.deepEqual(h.removed.mock.calls[0]?.arguments, [id]);
});

test("a pending event refuses the delete with 409 and keeps the inbound", async (t) => {
  const h = harness(t);
  const id = h.insert();
  h.insertEvent(id, "e1", InboundEventState.Pending);
  h.insertEvent(id, "e2", InboundEventState.Succeeded);
  const error = await refusal(h.remove(id));
  assert.equal(error.status, HttpStatus.Conflict);
  assert.equal(error.code, EVENTS_PENDING);
  assert.equal(h.inboundRows(id), ONE_ROW);
  assert.equal(h.eventRows(id), TWO_ROWS);
  assert.equal(h.removed.mock.callCount(), NO_CALLS);
});

test("a repeat delete after a success answers 404", async (t) => {
  const h = harness(t);
  const id = h.insert();
  assert.equal(await h.remove(id), null);
  const error = await refusal(h.remove(id));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
  assert.equal(h.removed.mock.callCount(), ONE_CALL);
});

test("a delete of an unknown inbound answers 404", async (t) => {
  const h = harness(t);
  const error = await refusal(h.remove(allocateInboundId()));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
});

test("an identity of another prefix fails the params schema", () => {
  const result = intakeOperations["inbound.delete"].input.safeParse({
    params: { inbound_id: createIdentity("outbound_request") },
    query: {},
    body: null,
  });
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ["params", "inbound_id"]);
});
