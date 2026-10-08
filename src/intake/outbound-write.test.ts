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
  ResultClass,
  intakeOperations,
  type OutboundRequestStateValue,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  discard,
  fail,
  findById,
  insertPending,
  succeed,
} from "./outbound-store.ts";
import { FinalizationKind, type CallAnswer } from "./outbound.ts";
import { unusedActionDependencies } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREATED_AT = 100;
const FAILED_AT = 200;
const RESULT = { url: "https://github.com/acme/app/pull/7", number: 7 };
const FAILURE = { code: ResultClass.FinalRefusal, message: "Refused." };
const NOT_FOUND = "intake.outbound.request.not_found";
const IN_FLIGHT = "intake.outbound.request.in_flight";
const STATE_CONFLICT = "intake.outbound.request.state_conflict";
const FORCE_REQUIRED = "intake.outbound.request.force_required";
const FILTER_INVALID = "intake.outbound.request.filter_invalid";
const LONG_DEADLINE_MS = 5000;
const NO_ROWS = 0;
const FIRST_ROW = 0;
const TWO_ROWS = 2;

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
  const discardRequest = async (id: string) => {
    const operation = intakeOperations["outbound.request.discard"];
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
  const deleteRequests = async (body: Record<string, unknown>) => {
    const operation = intakeOperations["outbound.request.delete"];
    return operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query: {}, body }),
          caller,
        ),
    );
  };
  const insert = (key: string, state: OutboundRequestStateValue) =>
    store.transaction((tx) => {
      const id = insertPending(tx, {
        project_id: PROJECT_ID,
        operation: OutboundOperation.GitHubPullRequest,
        request_key: key,
        credential: null,
        created_at: CREATED_AT,
      });
      if (state === OutboundRequestState.Discarded) assert.ok(discard(tx, id));
      if (state === OutboundRequestState.Failed)
        assert.ok(fail(tx, id, FAILURE, FAILED_AT));
      if (state === OutboundRequestState.Succeeded)
        assert.ok(succeed(tx, id, RESULT, [OutboundRequestState.Pending]));
      return id;
    });
  const stateOf = (id: string) =>
    store.transaction((tx) => findById(tx, id)?.state ?? null);
  return {
    intake,
    caller,
    discardRequest,
    deleteRequests,
    insert,
    stateOf,
  };
}

async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  const error = await promise.then(
    () => null,
    (failure: unknown) => failure,
  );
  assert.ok(error instanceof OperationError);
  return error;
}

async function refusesWith(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<void> {
  const error = await refusal(promise);
  assert.equal(error.status, status);
  assert.equal(error.code, code);
}

test("a delete with force absent or false answers 400 force_required", async (t) => {
  const h = harness(t);
  const id = h.insert("k1", OutboundRequestState.Failed);
  for (const force of [undefined, false]) {
    await refusesWith(
      h.deleteRequests({ force, ids: [id] }),
      HttpStatus.BadRequest,
      FORCE_REQUIRED,
    );
  }
  assert.equal(h.stateOf(id), OutboundRequestState.Failed);
});

test("no filter, both filters and the state pending answer 400 filter_invalid", async (t) => {
  const h = harness(t);
  const id = h.insert("k1", OutboundRequestState.Failed);
  const bodies = [
    { force: true },
    { force: true, state: OutboundRequestState.Failed, from: id },
    {
      force: true,
      state: OutboundRequestState.Failed,
      from: id,
      to: id,
      ids: [id],
    },
    { force: true, state: OutboundRequestState.Failed, ids: [id] },
    { force: true, state: OutboundRequestState.Pending, from: id, to: id },
  ];
  for (const body of bodies) {
    await refusesWith(
      h.deleteRequests(body),
      HttpStatus.BadRequest,
      FILTER_INVALID,
    );
  }
  assert.equal(h.stateOf(id), OutboundRequestState.Failed);
});

test("an ids list with a succeeded and a pending row deletes nothing", async (t) => {
  const h = harness(t);
  const settled = h.insert("k1", OutboundRequestState.Succeeded);
  const pending = h.insert("k2", OutboundRequestState.Pending);
  await refusesWith(
    h.deleteRequests({ force: true, ids: [settled, pending] }),
    HttpStatus.Conflict,
    STATE_CONFLICT,
  );
  assert.equal(h.stateOf(settled), OutboundRequestState.Succeeded);
  assert.equal(h.stateOf(pending), OutboundRequestState.Pending);
});

test("a range of failed removes the failed rows of the range alone", async (t) => {
  const h = harness(t);
  const discarded = h.insert("k1", OutboundRequestState.Discarded);
  const [first, last, outside] = ["k2", "k3", "k4"]
    .map((key) => h.insert(key, OutboundRequestState.Failed))
    .sort();
  assert.ok(first && last && outside);
  const answer = await h.deleteRequests({
    force: true,
    state: OutboundRequestState.Failed,
    from: first < discarded ? first : discarded,
    to: last,
  });
  assert.deepEqual(answer, { count: TWO_ROWS });
  assert.equal(h.stateOf(first), null);
  assert.equal(h.stateOf(last), null);
  assert.equal(h.stateOf(discarded), OutboundRequestState.Discarded);
  assert.equal(h.stateOf(outside), OutboundRequestState.Failed);
});

test("an ids delete with a missing identity counts the others", async (t) => {
  const h = harness(t);
  const failed = h.insert("k1", OutboundRequestState.Failed);
  const discarded = h.insert("k2", OutboundRequestState.Discarded);
  const missing = createIdentity("outbound_request");
  const answer = await h.deleteRequests({
    force: true,
    ids: [failed, missing, discarded],
  });
  assert.deepEqual(answer, { count: TWO_ROWS });
  assert.equal(h.stateOf(failed), null);
  assert.equal(h.stateOf(discarded), null);
});

test("a discard turns a pending request to discarded and answers 404 for an absent row", async (t) => {
  const h = harness(t);
  const id = h.insert("k1", OutboundRequestState.Pending);
  const record = await h.discardRequest(id);
  assert.equal(record.id, id);
  assert.equal(record.state, OutboundRequestState.Discarded);
  assert.equal(h.stateOf(id), OutboundRequestState.Discarded);
  await refusesWith(
    h.discardRequest(createIdentity("outbound_request")),
    HttpStatus.NotFound,
    NOT_FOUND,
  );
});

test("a discard of a running request answers 409 in_flight and the running write keeps its result", async (t) => {
  const h = harness(t);
  const answer = Promise.withResolvers<CallAnswer>();
  const started = Promise.withResolvers<void>();
  const running = h.intake.runOutbound(h.caller, {
    requestKey: "k1",
    deadlineMs: LONG_DEADLINE_MS,
    resultCodec: { encode: (value) => value, decode: (stored) => stored },
    authorize: () => ({
      operation: OutboundOperation.GitHubPullRequest,
      project_id: PROJECT_ID,
      credential: null,
      material: null,
    }),
    call: () => {
      started.resolve();
      return answer.promise;
    },
    readBack: async () => ({ match: false }),
    finalize: (outcome) => ({ kind: FinalizationKind.Answer, body: outcome }),
  });
  await started.promise;
  const page = h.caller.commit((tx) =>
    tx.database.prepare("SELECT id FROM intake_outbound_request").all(),
  ) as { id: string }[];
  assert.notEqual(page.length, NO_ROWS);
  const id = page[FIRST_ROW]!.id;
  await refusesWith(h.discardRequest(id), HttpStatus.Conflict, IN_FLIGHT);
  answer.resolve({ ok: true, result: RESULT });
  assert.deepEqual(await running, { ok: true, result: RESULT });
  assert.equal(h.stateOf(id), OutboundRequestState.Succeeded);
});

test("a discard of a failed request answers 409 state_conflict", async (t) => {
  const h = harness(t);
  const id = h.insert("k1", OutboundRequestState.Failed);
  await refusesWith(h.discardRequest(id), HttpStatus.Conflict, STATE_CONFLICT);
  assert.equal(h.stateOf(id), OutboundRequestState.Failed);
});
