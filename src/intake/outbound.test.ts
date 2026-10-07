import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import pino, { type Logger } from "pino";
import type { Material } from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  INTAKE_SERVICE_NAME,
  OutboundOperation,
  OutboundRequestState,
  RESULT_MAX_BYTES,
  ResultClass,
} from "./contract.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  FinalizationKind,
  runOutbound,
  type CallAnswer,
  type Finalization,
  type OutboundAnswer,
  type OutboundRun,
  type OutboundScope,
  type ReadBack,
} from "./outbound.ts";
import {
  discard,
  findByKey,
  insertPending,
  outboundRecord,
  type OutboundRow,
} from "./outbound-store.ts";
import { discardOutbound } from "./outbound-write.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REQUEST_KEY = "request-key-1";
const OTHER_REQUEST_KEY = "request-key-2";
const CREDENTIAL = "github-main";
const SECRET = "fake-secret-material-value";
const DEADLINE_MS = 30;
const LONG_DEADLINE_MS = 5000;
const ADDRESS = { url: "https://github.com/acme/app/pull/7", number: 7 };
const OTHER_ADDRESS = { url: "https://github.com/acme/app/pull/8", number: 8 };
const REFUSAL: OutboundAnswer = {
  ok: false,
  class: ResultClass.FinalRefusal,
  code: "repository.github.refused",
  message: "The base branch is protected.",
};
const IN_FLIGHT = "intake.outbound.request.in_flight";
const DISCARDED = "intake.outbound.request.discarded";
const AUTHORIZE_REFUSED = "intake.outbound.request.test_refused";
const FINALIZE_FAILED = "intake.outbound.request.test_failed";
const TIMEOUT = "timeout";
const NO_ITEMS = 0;
const SINGLE_RUN = 1;
const MATERIAL_RUNS = 4;

class FakeMaterial implements Material {
  readonly credential_id = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  readonly platform = "github";
  drops = 0;

  value(): unknown {
    return SECRET;
  }

  drop(): void {
    this.drops += SINGLE_RUN;
  }
}

interface Script {
  call?: (scope: OutboundScope) => Promise<CallAnswer>;
  readBack?: (scope: OutboundScope) => Promise<ReadBack>;
  finalize?: (answer: OutboundAnswer) => Finalization<OutboundAnswer>;
  encode?: (value: unknown) => unknown;
  refuse?: boolean;
  requestKey?: string;
  deadlineMs?: number;
}

interface Counts {
  calls: number;
  readBacks: number;
  materials: FakeMaterial[];
}

interface Harness {
  store: Store;
  inFlight: Set<string>;
  logger: Logger;
  lines: string[];
  counts: Counts;
}

function migrate(store: Store): void {
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
}

function harness(t: TestContext): Harness {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  migrate(store);
  const lines: string[] = [];
  const logger = pino(
    { level: "trace" },
    { write: (line) => lines.push(line) },
  );
  return {
    store,
    inFlight: new Set(),
    logger,
    lines,
    counts: { calls: 0, readBacks: 0, materials: [] },
  };
}

function callerOf(store: Store): CallerContext {
  return {
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
}

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function request(counts: Counts, script: Script): OutboundRun<OutboundAnswer> {
  return {
    requestKey: script.requestKey ?? REQUEST_KEY,
    deadlineMs: script.deadlineMs ?? LONG_DEADLINE_MS,
    resultCodec: {
      encode: script.encode ?? ((value) => value),
      decode: (stored) => stored,
    },
    authorize: () => {
      if (script.refuse)
        throw new OperationError(403, AUTHORIZE_REFUSED, "Refused.");
      const material = new FakeMaterial();
      counts.materials.push(material);
      return {
        operation: OutboundOperation.GitHubPullRequest,
        project_id: PROJECT_ID,
        credential: CREDENTIAL,
        material,
      };
    },
    call: (material, scope) => {
      assert.equal(material?.value(), SECRET);
      counts.calls += SINGLE_RUN;
      return (script.call ?? (() => never()))(scope);
    },
    readBack: (material, scope) => {
      assert.equal(material?.value(), SECRET);
      counts.readBacks += SINGLE_RUN;
      return (script.readBack ?? (async () => ({ match: false })))(scope);
    },
    finalize:
      script.finalize ??
      ((answer) => ({ kind: FinalizationKind.Answer, body: answer })),
  };
}

function run(h: Harness, script: Script): Promise<OutboundAnswer> {
  return runOutbound(
    { store: h.store, logger: h.logger, inFlight: h.inFlight },
    callerOf(h.store),
    request(h.counts, script),
  );
}

function row(store: Store): OutboundRow | null {
  return store.transaction((tx) =>
    findByKey(tx, OutboundOperation.GitHubPullRequest, REQUEST_KEY),
  );
}

function stored(store: Store): OutboundRow {
  const current = row(store);
  assert.ok(current);
  return current;
}

function insertRow(store: Store, requestKey = REQUEST_KEY): string {
  return store.transaction((tx) =>
    insertPending(tx, {
      project_id: PROJECT_ID,
      operation: OutboundOperation.GitHubPullRequest,
      request_key: requestKey,
      credential: CREDENTIAL,
      created_at: Date.now(),
    }),
  );
}

async function failedRow(h: Harness): Promise<OutboundAnswer> {
  const answer = await run(h, { call: async () => REFUSAL });
  assert.equal(stored(h.store).state, OutboundRequestState.Failed);
  return answer;
}

function rejectsWith(promise: Promise<unknown>, code: string) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.code, code);
    return true;
  });
}

test("A timed-out write stores timeout, and a matched repeat stores succeeded with one call", async (t) => {
  const h = harness(t);
  const timed = await run(h, { deadlineMs: DEADLINE_MS });
  assert.equal(timed.ok, false);
  assert.ok(!timed.ok);
  assert.equal(timed.class, ResultClass.UnknownOutcome);
  assert.equal(timed.code, TIMEOUT);
  const failed = outboundRecord(stored(h.store));
  assert.equal(failed.state, OutboundRequestState.Failed);
  assert.equal(failed.error?.[0]?.code, TIMEOUT);
  const matched = await run(h, {
    readBack: async () => ({ match: true, result: ADDRESS }),
  });
  assert.deepEqual(matched, { ok: true, result: ADDRESS });
  const succeeded = outboundRecord(stored(h.store));
  assert.equal(succeeded.state, OutboundRequestState.Succeeded);
  assert.deepEqual(succeeded.result, ADDRESS);
  assert.equal(h.counts.calls, SINGLE_RUN);
  assert.equal(h.counts.readBacks, SINGLE_RUN);
});

test("A caller cancellation during the call stores unknown_outcome, not timeout", async (t) => {
  const h = harness(t);
  const context = new CancellationContext(background, null);
  const caller = { ...callerOf(h.store), context };
  const answer = runOutbound(
    { store: h.store, logger: h.logger, inFlight: h.inFlight },
    caller,
    request(h.counts, {
      call: () => {
        context.cancel();
        return never();
      },
    }),
  );
  const cancelled = await answer;
  assert.ok(!cancelled.ok);
  assert.equal(cancelled.class, ResultClass.UnknownOutcome);
  assert.equal(cancelled.code, ResultClass.UnknownOutcome);
  const record = outboundRecord(stored(h.store));
  assert.equal(record.state, OutboundRequestState.Failed);
  assert.equal(record.error?.[0]?.code, ResultClass.UnknownOutcome);
  const repeat = await run(h, {});
  assert.deepEqual(repeat, cancelled);
  assert.equal(h.counts.calls, SINGLE_RUN);
  assert.equal(h.inFlight.size, NO_ITEMS);
});

test("A call that ignores its signal ends at the deadline, and its late answer writes nothing", async (t) => {
  const h = harness(t);
  const late = Promise.withResolvers<CallAnswer>();
  let aborted = false;
  const answer = await run(h, {
    deadlineMs: DEADLINE_MS,
    call: (scope) => {
      scope.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return late.promise;
    },
  });
  assert.ok(!answer.ok);
  assert.equal(answer.code, TIMEOUT);
  assert.ok(aborted);
  late.resolve({ ok: true, result: ADDRESS });
  await tick();
  const record = outboundRecord(stored(h.store));
  assert.equal(record.state, OutboundRequestState.Failed);
  assert.equal(record.result, null);
  assert.equal(record.error?.length, SINGLE_RUN);
  assert.equal(h.inFlight.size, NO_ITEMS);
});

test("A restart after the insert calls nothing, and a repeat with no match answers unknown_outcome", async (t) => {
  const path = join(temporary(t), "kanthord.db");
  const first = new Store(path);
  migrate(first);
  const counts: Counts = { calls: 0, readBacks: 0, materials: [] };
  const crash = new Error("The process stops.");
  const logger = pino({ enabled: false });
  const before = new IntakeService({
    store: first,
    logger,
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
  });
  const crashed = before.runOutbound(
    callerOf(first),
    request(counts, {
      call: async () => {
        first.close();
        throw crash;
      },
    }),
  );
  await assert.rejects(crashed, (error) => error === crash);
  const second = new Store(path);
  t.after(() => second.close());
  const after = new IntakeService({
    store: second,
    logger,
    health: new HealthRegistry(),
    identity: { kind: IdentityKind.Service, service: INTAKE_SERVICE_NAME },
  });
  assert.equal(await after.start(), null);
  t.after(() => after.stop());
  assert.equal(stored(second).state, OutboundRequestState.Pending);
  assert.equal(counts.calls, SINGLE_RUN);
  assert.equal(counts.readBacks, NO_ITEMS);
  const answer = await after.runOutbound(callerOf(second), request(counts, {}));
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.UnknownOutcome);
  assert.equal(counts.calls, SINGLE_RUN);
  assert.equal(counts.readBacks, SINGLE_RUN);
  assert.equal(stored(second).state, OutboundRequestState.Pending);
});

test("Two concurrent runs of one key make one call, and the refused repeat keeps the membership", async (t) => {
  const h = harness(t);
  const answer = Promise.withResolvers<CallAnswer>();
  const first = run(h, { call: () => answer.promise });
  await rejectsWith(run(h, { call: () => answer.promise }), IN_FLIGHT);
  const id = stored(h.store).id;
  assert.ok(h.inFlight.has(id));
  await rejectsWith(run(h, {}), IN_FLIGHT);
  assert.ok(h.inFlight.has(id));
  assert.throws(
    () => h.store.transaction((tx) => discardOutbound(tx, h.inFlight, id)),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.equal(error.code, IN_FLIGHT);
      return true;
    },
  );
  assert.equal(stored(h.store).state, OutboundRequestState.Pending);
  answer.resolve({ ok: true, result: ADDRESS });
  assert.deepEqual(await first, { ok: true, result: ADDRESS });
  assert.equal(h.counts.calls, SINGLE_RUN);
  assert.equal(h.inFlight.size, NO_ITEMS);
});

test("A repeat of succeeded answers its decoded result with no call and no read-back", async (t) => {
  const h = harness(t);
  await run(h, { call: async () => ({ ok: true, result: ADDRESS }) });
  const repeat = await run(h, {});
  assert.deepEqual(repeat, { ok: true, result: ADDRESS });
  assert.equal(h.counts.calls, SINGLE_RUN);
  assert.equal(h.counts.readBacks, NO_ITEMS);
});

test("A repeat of failed with no match answers the newest stored error exactly", async (t) => {
  const h = harness(t);
  const first = await failedRow(h);
  const repeat = await run(h, {});
  assert.deepEqual(repeat, first);
  assert.deepEqual(repeat, REFUSAL);
  assert.equal(h.counts.calls, SINGLE_RUN);
  assert.equal(h.counts.readBacks, SINGLE_RUN);
});

test("A timed-out or refused read-back leaves the state and the error history unchanged", async (t) => {
  const h = harness(t);
  insertRow(h.store);
  const pendingBefore = stored(h.store);
  await run(h, { deadlineMs: DEADLINE_MS, readBack: () => never() });
  await run(h, { readBack: async () => Promise.reject(new Error("refused")) });
  assert.deepEqual(stored(h.store), pendingBefore);
  const other = harness(t);
  await failedRow(other);
  const failedBefore = stored(other.store);
  await run(other, { deadlineMs: DEADLINE_MS, readBack: () => never() });
  await run(other, {
    readBack: async () => Promise.reject(new Error("refused")),
  });
  assert.deepEqual(stored(other.store), failedBefore);
  assert.equal(h.counts.calls, NO_ITEMS);
});

test("A human delete during a read-back recreates no row, and the repeat answers the match", async (t) => {
  const h = harness(t);
  await failedRow(h);
  const id = stored(h.store).id;
  const answer = await run(h, {
    readBack: async () => {
      h.store.database
        .prepare("DELETE FROM intake_outbound_request WHERE id = ?")
        .run(id);
      return { match: true, result: OTHER_ADDRESS };
    },
  });
  assert.deepEqual(answer, { ok: true, result: OTHER_ADDRESS });
  assert.equal(row(h.store), null);
  assert.equal(h.inFlight.size, NO_ITEMS);
});

test("A repeat of discarded answers 409 discarded", async (t) => {
  const h = harness(t);
  const id = insertRow(h.store);
  assert.ok(h.store.transaction((tx) => discard(tx, id)));
  await rejectsWith(run(h, {}), DISCARDED);
  assert.equal(h.counts.calls, NO_ITEMS);
  assert.equal(h.counts.readBacks, NO_ITEMS);
});

test("A refusal of authorize inserts no row and calls nothing", async (t) => {
  const h = harness(t);
  await rejectsWith(run(h, { refuse: true }), AUTHORIZE_REFUSED);
  assert.equal(row(h.store), null);
  assert.equal(h.counts.calls, NO_ITEMS);
  assert.equal(h.inFlight.size, NO_ITEMS);
});

test("A finalization to an error commits failed before the error reaches the caller", async (t) => {
  const h = harness(t);
  const failure = new OperationError(422, FINALIZE_FAILED, "Refused.");
  await rejectsWith(
    run(h, {
      call: async () => REFUSAL,
      finalize: () => ({ kind: FinalizationKind.Error, error: failure }),
    }),
    FINALIZE_FAILED,
  );
  const record = outboundRecord(stored(h.store));
  assert.equal(record.state, OutboundRequestState.Failed);
  assert.deepEqual(
    record.error?.map((item) => item.code),
    [ResultClass.FinalRefusal],
  );
});

test("A rejected call and a rejected read-back leave no owned identity", async (t) => {
  const h = harness(t);
  const broken = new Error("broken call");
  await assert.rejects(
    run(h, { call: async () => Promise.reject(broken) }),
    (error) => error === broken,
  );
  assert.equal(h.inFlight.size, NO_ITEMS);
  assert.equal(stored(h.store).state, OutboundRequestState.Pending);
  await run(h, { readBack: async () => Promise.reject(broken) });
  assert.equal(h.inFlight.size, NO_ITEMS);
  assert.equal(h.counts.readBacks, SINGLE_RUN);
});

test("A result that fails its codec or its bound fails the commit with no owned identity", async (t) => {
  const h = harness(t);
  const broken = new Error("codec refused");
  await assert.rejects(
    run(h, {
      call: async () => ({ ok: true, result: ADDRESS }),
      encode: () => {
        throw broken;
      },
    }),
    (error) => error === broken,
  );
  assert.equal(h.inFlight.size, NO_ITEMS);
  assert.equal(stored(h.store).state, OutboundRequestState.Pending);
  const oversized = "x".repeat(RESULT_MAX_BYTES + SINGLE_RUN);
  await assert.rejects(
    run(h, { readBack: async () => ({ match: true, result: oversized }) }),
    assert.AssertionError,
  );
  assert.equal(h.inFlight.size, NO_ITEMS);
  assert.equal(stored(h.store).state, OutboundRequestState.Pending);
});

test("drop runs after a success, a failure and a refusal, and no record holds the material", async (t) => {
  const h = harness(t);
  await failedRow(h);
  await run(h, {
    readBack: async () => Promise.reject(new Error(`leak ${SECRET}`)),
  });
  await run(h, { readBack: async () => ({ match: true, result: ADDRESS }) });
  const id = insertRow(h.store, OTHER_REQUEST_KEY);
  assert.ok(h.store.transaction((tx) => discard(tx, id)));
  await rejectsWith(run(h, { requestKey: OTHER_REQUEST_KEY }), DISCARDED);
  assert.equal(h.counts.materials.length, MATERIAL_RUNS);
  assert.ok(
    h.counts.materials.every((material) => material.drops === SINGLE_RUN),
  );
  const rows = h.store.database
    .prepare("SELECT * FROM intake_outbound_request")
    .all();
  assert.ok(!JSON.stringify(rows).includes(SECRET));
  assert.ok(h.lines.length > NO_ITEMS);
  assert.ok(!h.lines.join("").includes(SECRET));
});
