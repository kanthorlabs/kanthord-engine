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
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundKindValue,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";
import { webhookSecret } from "./webhook-secret.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const RESOURCE = "owner/repo";
const CREDENTIAL = "github-token";
const CREATED_AT = 100;
const NOT_FOUND = "intake.inbound.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const PAGE_SIZE = 2;
const FIRST_ROW = 0;
const SECOND_ROW = 1;
const PROJECTION_KEYS = [
  "checkpoint",
  "configuration",
  "consumer",
  "created_at",
  "credential",
  "id",
  "kind",
  "platform",
  "project_id",
];

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const dependencies = unusedActionDependencies();
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
    ...dependencies,
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const list = async (query: Record<string, unknown> = {}) => {
    const operation = intakeOperations["inbound.list"];
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
    const operation = intakeOperations["inbound.get"];
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
  const insert = (
    options: { project_id?: string; kind?: InboundKindValue } = {},
  ) =>
    store.transaction((tx) => {
      const id = allocateInboundId();
      const kind = options.kind ?? InboundKind.Webhook;
      insertInbound(tx, id, {
        project_id: options.project_id ?? PROJECT_ID,
        kind,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: kind === InboundKind.Poll ? CREDENTIAL : null,
        configuration: { resource: RESOURCE },
        checkpoint: null,
        created_at: CREATED_AT,
      });
      return id;
    });
  return { list, get, insert, masterKey: dependencies.masterKey };
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

test("the list combines the project, kind and platform filters with AND", async (t) => {
  const h = harness(t);
  const target = h.insert({
    project_id: OTHER_PROJECT_ID,
    kind: InboundKind.Poll,
  });
  const webhook = h.insert();
  h.insert({ project_id: OTHER_PROJECT_ID });
  h.insert({ kind: InboundKind.Poll });
  const ids = async (query: Record<string, unknown>) =>
    (await h.list(query)).items.map((item) => item.id);
  assert.equal((await ids({ project_id: OTHER_PROJECT_ID })).length, PAGE_SIZE);
  assert.equal((await ids({ kind: InboundKind.Poll })).length, PAGE_SIZE);
  assert.equal(
    (await ids({ platform: InboundPlatform.GitHub })).length,
    PAGE_SIZE * PAGE_SIZE,
  );
  assert.deepEqual(
    await ids({
      project_id: OTHER_PROJECT_ID,
      kind: InboundKind.Poll,
      platform: InboundPlatform.GitHub,
    }),
    [target],
  );
  assert.deepEqual(
    await ids({ project_id: PROJECT_ID, kind: InboundKind.Webhook }),
    [webhook],
  );
});

test("a list item is the projection with no address and no secret", async (t) => {
  const h = harness(t);
  h.insert();
  const [item] = (await h.list()).items;
  assert.deepEqual(Object.keys(item!).sort(), PROJECTION_KEYS);
});

test("a page of two answers the newest first with a cursor to the rest", async (t) => {
  const h = harness(t);
  const ids = [h.insert(), h.insert(), h.insert()];
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
    Buffer.from(createIdentity("outbound_request")).toString("base64url"),
  ]) {
    const error = await refusal(h.list({ cursor }));
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, CURSOR_INVALID);
  }
});

test("a webhook get answers the projection with the address and the derived secret", async (t) => {
  const h = harness(t);
  const id = h.insert();
  const record = await h.get(id);
  assert.deepEqual(
    Object.keys(record).sort(),
    [...PROJECTION_KEYS, "address", "secret"].sort(),
  );
  assert.equal(record.id, id);
  assert.equal(record.kind, InboundKind.Webhook);
  assert.ok("address" in record && "secret" in record);
  assert.equal(record.address, `/hooks/${id}`);
  assert.equal(record.secret, webhookSecret(h.masterKey, id));
});

test("a poll get answers the projection with no address and no secret", async (t) => {
  const h = harness(t);
  const id = h.insert({ kind: InboundKind.Poll });
  const record = await h.get(id);
  assert.deepEqual(Object.keys(record).sort(), PROJECTION_KEYS);
  assert.equal(record.credential, CREDENTIAL);
});

test("a get of an unknown identity answers 404 not_found", async (t) => {
  const h = harness(t);
  const error = await refusal(h.get(createIdentity("inbound")));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
});

test("a get of an identity of another prefix fails the params schema", () => {
  const parsed = intakeOperations["inbound.get"].input.safeParse({
    params: { inbound_id: createIdentity("outbound_request") },
    query: {},
    body: null,
  });
  assert.equal(parsed.success, false);
  assert.deepEqual(
    new Set(parsed.error?.issues.map((issue) => issue.path.join("."))),
    new Set(["params.inbound_id"]),
  );
});
