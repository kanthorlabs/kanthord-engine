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
  INTAKE_SERVICE_NAME,
  OutboundOperation,
  OutboundRequestState,
  intakeOperations,
  type OutboundOperationValue,
  type OutboundRequestStateValue,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import { discard, insertPending } from "./outbound-store.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const CREATED_AT = 100;
const NOT_FOUND = "intake.outbound.request.not_found";
const CURSOR_INVALID = "system.pagination.cursor_invalid";
const PAGE_SIZE = 2;
const FIRST_ROW = 0;
const SECOND_ROW = 1;

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
    const operation = intakeOperations["outbound.request.list"];
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
    const operation = intakeOperations["outbound.request.get"];
    return operation.output.parse(
      await registry.get(operation.id).handler(
        operation.input.parse({
          params: { outbound_request_id: id },
          query: {},
          body: null,
        }),
        caller,
      ),
    );
  };
  const insert = (
    key: string,
    options: {
      project_id?: string;
      operation?: OutboundOperationValue;
      state?: OutboundRequestStateValue;
    } = {},
  ) =>
    store.transaction((tx) => {
      const id = insertPending(tx, {
        project_id: options.project_id ?? PROJECT_ID,
        operation: options.operation ?? OutboundOperation.GitHubPullRequest,
        request_key: key,
        credential: null,
        created_at: CREATED_AT,
      });
      if (options.state === OutboundRequestState.Discarded) discard(tx, id);
      return id;
    });
  return { list, get, insert };
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

test("the list combines the project, state and operation filters with AND", async (t) => {
  const h = harness(t);
  const target = h.insert("k1", {
    project_id: OTHER_PROJECT_ID,
    operation: OutboundOperation.S3DeleteObject,
    state: OutboundRequestState.Discarded,
  });
  h.insert("k2");
  h.insert("k3", { project_id: OTHER_PROJECT_ID });
  h.insert("k4", { operation: OutboundOperation.S3DeleteObject });
  const ids = async (query: Record<string, unknown>) =>
    (await h.list(query)).items.map((item) => item.id);
  assert.equal((await ids({ project_id: OTHER_PROJECT_ID })).length, PAGE_SIZE);
  assert.deepEqual(await ids({ state: OutboundRequestState.Discarded }), [
    target,
  ]);
  assert.equal(
    (await ids({ operation: OutboundOperation.S3DeleteObject })).length,
    PAGE_SIZE,
  );
  assert.deepEqual(
    await ids({
      project_id: OTHER_PROJECT_ID,
      state: OutboundRequestState.Discarded,
      operation: OutboundOperation.S3DeleteObject,
    }),
    [target],
  );
  assert.deepEqual(
    await ids({
      project_id: PROJECT_ID,
      state: OutboundRequestState.Discarded,
    }),
    [],
  );
});

test("a page of two answers the newest first with a cursor to the rest", async (t) => {
  const h = harness(t);
  const ids = ["k1", "k2", "k3"].map((key) => h.insert(key));
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
  for (const cursor of ["!!", Buffer.from("junk").toString("base64url")]) {
    const error = await refusal(h.list({ cursor }));
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, CURSOR_INVALID);
  }
});

test("a get answers the projection and 404 for an unknown identity", async (t) => {
  const h = harness(t);
  const id = h.insert("k1");
  const record = await h.get(id);
  assert.equal(record.id, id);
  assert.equal(record.state, OutboundRequestState.Pending);
  assert.equal(record.result, null);
  assert.deepEqual(Object.keys(record).sort(), [
    "created_at",
    "error",
    "id",
    "operation",
    "project_id",
    "request_key",
    "result",
    "state",
  ]);
  const error = await refusal(h.get(createIdentity("outbound_request")));
  assert.equal(error.status, HttpStatus.NotFound);
  assert.equal(error.code, NOT_FOUND);
});
