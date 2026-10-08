import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import {
  GrantKind,
  InboundOperation,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import type {
  GitHubAnswer,
  GitHubCall,
  GitHubCheckpoint,
  GitHubEvent,
  GitHubEventsAnswer,
  GitHubEventsQuery,
} from "../repository/github.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
  PLATFORM_CALL_DEADLINE_MS,
  ResultClass,
} from "./contract.ts";
import { insertEvent } from "./event-store.ts";
import { removeInbound } from "./inbound-delete.ts";
import {
  allocateInboundId,
  deleteInbound,
  insertInbound,
} from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  CycleOutcome,
  pollCycle,
  storeBatch,
  PollLoops,
  type PollCycleDependencies,
} from "./poll.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const RESOURCE = "owner/repo";
const ETAG_STORED = '"etag-0"';
const ETAG_FIRST = '"etag-1"';
const ETAG_SECOND = '"etag-2"';
const SMALL_LIMIT = 2;
const ONE_LIMIT = 1;
const LARGE_LIMIT = 100;
const TOKEN = "ghp_poll-token";
const RETRYABLE_CODE = "repository.platform.github.retryable_refusal";
const SERVER_ERROR_STATUS = 500;
const NO_CALLS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const INTERVAL_MS = 1000;
const ONE_MS = 1;
const SETTLE_TURNS = 20;
const UNKNOWN_CODE = "system.operation.unknown";
const SERVICE_IDENTITY = {
  kind: IdentityKind.Service,
  service: INTAKE_SERVICE_NAME,
} as const;

type EventsAnswer = GitHubAnswer<GitHubEventsAnswer>;

interface HarnessOptions {
  limit?: number;
  checkpoint?: GitHubCheckpoint | null;
}

function ev(id: string, type: string): GitHubEvent {
  return {
    id,
    type,
    body: new Uint8Array(Buffer.from(JSON.stringify({ id, type }))),
  };
}

function harness(t: TestContext, options: HarnessOptions = {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const inboundId = allocateInboundId();
  const limit = options.limit ?? LARGE_LIMIT;
  store.transaction((tx) =>
    insertInbound(tx, inboundId, {
      project_id: PROJECT_ID,
      kind: InboundKind.Poll,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: CREDENTIAL,
      configuration: { resource: RESOURCE },
      checkpoint: options.checkpoint ?? null,
      created_at: 1,
    }),
  );
  const batch = (etag: string | null, events: GitHubEvent[]) =>
    store.transaction((tx) =>
      storeBatch(tx, limit, inboundId, { etag, events }),
    );
  const checkpoint = () =>
    store.transaction((tx) => {
      const row = tx.database
        .prepare("SELECT checkpoint FROM intake_inbound WHERE id = ?")
        .get(inboundId) as { checkpoint: string | null } | undefined;
      assert.ok(row);
      return row.checkpoint === null ? null : JSON.parse(row.checkpoint);
    });
  const events = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare(
            "SELECT event_id, metadata, event FROM intake_inbound_event ORDER BY event_id",
          )
          .all() as { event_id: string; metadata: string; event: Uint8Array }[]
      ).map((row) => ({
        event_id: row.event_id,
        metadata: JSON.parse(row.metadata),
        event: Buffer.from(row.event).toString(),
      })),
    );
  const eventIds = () => events().map((row) => row.event_id);
  const addEvent = (eventId: string) =>
    store.transaction((tx) =>
      insertEvent(tx, {
        inbound_id: inboundId,
        event_id: eventId,
        event: new Uint8Array([1]),
        metadata: { event: "PushEvent" },
        created_at: 1,
      }),
    );
  const settleAll = () =>
    store.transaction((tx) =>
      tx.database
        .prepare("UPDATE intake_inbound_event SET state = ?")
        .run(InboundEventState.Succeeded),
    );
  return {
    store,
    inboundId,
    limit,
    batch,
    checkpoint,
    events,
    eventIds,
    addEvent,
    settleAll,
  };
}

test("a batch inserts the newer events in ascending order and writes the checkpoint", (t) => {
  const h = harness(t);
  assert.equal(
    h.batch(ETAG_FIRST, [
      ev("102", "PushEvent"),
      ev("101", "PullRequestEvent"),
    ]),
    true,
  );
  assert.deepEqual(h.events(), [
    {
      event_id: "101",
      metadata: { event: "PullRequestEvent" },
      event: JSON.stringify({ id: "101", type: "PullRequestEvent" }),
    },
    {
      event_id: "102",
      metadata: { event: "PushEvent" },
      event: JSON.stringify({ id: "102", type: "PushEvent" }),
    },
  ]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    newest_event_id: "102",
  });
});

test("an empty answer and an answer of known events keep newest_event_id and store the ETag", (t) => {
  const h = harness(t, {
    checkpoint: { etag: ETAG_STORED, newest_event_id: "101" },
  });
  h.batch(ETAG_FIRST, []);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    newest_event_id: "101",
  });
  h.batch(ETAG_SECOND, [ev("101", "PushEvent"), ev("100", "PushEvent")]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_SECOND,
    newest_event_id: "101",
  });
  assert.deepEqual(h.eventIds(), []);
});

test("a repeated event identity inserts no row", (t) => {
  const h = harness(t);
  h.addEvent("101");
  h.batch(ETAG_FIRST, [ev("102", "PushEvent"), ev("101", "PushEvent")]);
  assert.deepEqual(h.eventIds(), ["101", "102"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    newest_event_id: "102",
  });
});

test("a batch at the bound stores the events that fit with a null ETag, and the next batch after freed capacity stores the rest", (t) => {
  const h = harness(t, { limit: SMALL_LIMIT });
  const list = [
    ev("102", "PushEvent"),
    ev("101", "PushEvent"),
    ev("100", "PushEvent"),
  ];
  h.batch(ETAG_FIRST, list);
  assert.deepEqual(h.eventIds(), ["100", "101"]);
  assert.deepEqual(h.checkpoint(), { etag: null, newest_event_id: "101" });
  h.settleAll();
  h.batch(ETAG_FIRST, list);
  assert.deepEqual(h.eventIds(), ["100", "101", "102"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    newest_event_id: "102",
  });
});

test("a batch of a deleted inbound stores nothing and answers false", (t) => {
  const h = harness(t);
  h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
  assert.equal(h.batch(ETAG_FIRST, [ev("101", "PushEvent")]), false);
  assert.deepEqual(h.eventIds(), []);
});

function modified(etag: string | null, events: GitHubEvent[]): EventsAnswer {
  return { ok: true, value: { notModified: false, etag, events } };
}

function fakeCustody() {
  const grants: GrantRequest[] = [];
  const drops: string[] = [];
  const custody: PollCycleDependencies["custody"] = {
    authorizeOperation<R extends GrantRequest>(
      _tx: unknown,
      request: R,
    ): GrantOf<R["kind"]> {
      const inbound: GrantRequest = request;
      assert.ok(inbound.kind === GrantKind.Inbound);
      grants.push(inbound);
      const grant: GrantOf<typeof GrantKind.Inbound> = {
        kind: GrantKind.Inbound,
        credential: inbound.inbound.credential,
        platform: inbound.inbound.platform,
        project_id: inbound.inbound.projectId,
        execution: null,
        facts: {
          inbound_id: inbound.inbound.inboundId,
          resource: inbound.inbound.resource,
        },
      };
      return grant as GrantOf<R["kind"]>;
    },
    release(_tx, grant): Material {
      const credential = grant.credential;
      assert.ok(credential !== null);
      return {
        credential_id: "credential_1",
        platform: grant.platform,
        value: () => ({ key: TOKEN }),
        drop: () => drops.push(credential),
      };
    },
  };
  return { custody, grants, drops };
}

function cycleHarness(t: TestContext, options: HarnessOptions = {}) {
  const h = harness(t, options);
  const { custody, grants, drops } = fakeCustody();
  const calls: { call: GitHubCall; query: GitHubEventsQuery }[] = [];
  const answers: { next: () => Promise<EventsAnswer> } = {
    next: async () => modified(ETAG_FIRST, []),
  };
  const logger = pino({ enabled: false });
  const warn = t.mock.method(logger, "warn");
  const wakes = { count: 0 };
  const dependencies: PollCycleDependencies = {
    store: h.store,
    logger,
    identity: SERVICE_IDENTITY,
    custody,
    github: {
      listEvents: async (call, query) => {
        calls.push({ call, query });
        return answers.next();
      },
    },
    pendingEventLimit: h.limit,
    wake: () => {
      wakes.count += 1;
    },
  };
  const cycle = (context = background) =>
    pollCycle(dependencies, h.inboundId, context);
  return {
    ...h,
    grants,
    drops,
    calls,
    answers,
    warn,
    wakes,
    dependencies,
    cycle,
  };
}

test("a cycle releases one poll grant, requests the events under a deadline, stores the batch and wakes", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  assert.equal(await h.cycle(), CycleOutcome.Continue);
  assert.deepEqual(h.eventIds(), ["101"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    newest_event_id: "101",
  });
  assert.equal(h.wakes.count, ONE_CALL);
  assert.equal(h.calls.length, ONE_CALL);
  const [{ call, query }] = h.calls as [(typeof h.calls)[number]];
  assert.deepEqual(query, { owner: "owner", repo: "repo", etag: null });
  assert.equal(call.token, TOKEN);
  assert.equal(call.requester, SERVICE_IDENTITY);
  assert.ok(call.deadlineAt <= Date.now() + PLATFORM_CALL_DEADLINE_MS);
  assert.deepEqual(h.grants, [
    {
      kind: GrantKind.Inbound,
      identity: SERVICE_IDENTITY,
      inbound: {
        inboundId: h.inboundId,
        projectId: PROJECT_ID,
        credential: CREDENTIAL,
        platform: InboundPlatform.GitHub,
        resource: RESOURCE,
      },
      operation: InboundOperation.Poll,
    },
  ]);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

test("a 304 answer commits nothing and the request carries the stored ETag", async (t) => {
  const stored = { etag: ETAG_STORED, newest_event_id: "100" };
  const h = cycleHarness(t, { checkpoint: stored });
  h.answers.next = async () => ({ ok: true, value: { notModified: true } });
  assert.equal(await h.cycle(), CycleOutcome.Continue);
  assert.equal(h.calls[0]?.query.etag, ETAG_STORED);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.wakes.count, NO_CALLS);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

test("a cycle at the bound sends no request and releases nothing, and it resumes below the bound", async (t) => {
  const h = cycleHarness(t, { limit: ONE_LIMIT });
  h.addEvent("50");
  assert.equal(await h.cycle(), CycleOutcome.Continue);
  assert.equal(h.calls.length, NO_CALLS);
  assert.deepEqual(h.grants, []);
  h.settleAll();
  await h.cycle();
  assert.equal(h.calls.length, ONE_CALL);
});

test("the capacity bound pauses the poll, and a pending event refuses the delete of the inbound", async (t) => {
  const h = cycleHarness(t, { limit: SMALL_LIMIT });
  h.answers.next = async () =>
    modified(ETAG_FIRST, [
      ev("102", "PushEvent"),
      ev("101", "PushEvent"),
      ev("100", "PushEvent"),
    ]);
  await h.cycle();
  assert.deepEqual(h.eventIds(), ["100", "101"]);
  assert.deepEqual(h.checkpoint(), { etag: null, newest_event_id: "101" });
  await h.cycle();
  assert.equal(h.calls.length, ONE_CALL);
  assert.throws(
    () => h.store.transaction((tx) => removeInbound(tx, h.inboundId)),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === IntakeErrorCode.InboundEventsPending,
  );
  assert.deepEqual(h.eventIds(), ["100", "101"]);
});

test("a bound reached between the request and the commit leaves the new events unstored and writes a null ETag", async (t) => {
  const h = cycleHarness(t, {
    limit: ONE_LIMIT,
    checkpoint: { etag: ETAG_STORED, newest_event_id: "100" },
  });
  h.answers.next = async () => {
    h.addEvent("50");
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  await h.cycle();
  assert.deepEqual(h.eventIds(), ["50"]);
  assert.deepEqual(h.checkpoint(), { etag: null, newest_event_id: "100" });
});

test("a delete of the inbound before the commit stores no event and answers gone", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => {
    h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  assert.equal(await h.cycle(), CycleOutcome.Gone);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.wakes.count, NO_CALLS);
  assert.equal(await h.cycle(), CycleOutcome.Gone);
  assert.equal(h.calls.length, ONE_CALL);
});

test("a store failure leaves the checkpoint unchanged and drops the material", async (t) => {
  const stored = { etag: ETAG_STORED, newest_event_id: "100" };
  const h = cycleHarness(t, { checkpoint: stored });
  h.store.transaction((tx) =>
    tx.database.exec(
      "CREATE TRIGGER test_fail BEFORE INSERT ON intake_inbound_event BEGIN SELECT RAISE(ABORT, 'store failure'); END",
    ),
  );
  h.answers.next = async () => modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  await assert.rejects(h.cycle(), /store failure/);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.eventIds(), []);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

test("a result class leaves the checkpoint unchanged, logs the inbound and the code, and drops the material", async (t) => {
  const stored = { etag: ETAG_STORED, newest_event_id: "100" };
  const h = cycleHarness(t, { checkpoint: stored });
  h.answers.next = async () => ({
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: RETRYABLE_CODE,
    status: SERVER_ERROR_STATUS,
    message: "Server Error",
  });
  assert.equal(await h.cycle(), CycleOutcome.Continue);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.equal(h.warn.mock.callCount(), ONE_CALL);
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, { inbound_id: h.inboundId, code: RETRYABLE_CODE });
  assert.ok(!JSON.stringify(h.warn.mock.calls).includes(TOKEN));
});

test("a thrown request drops the material and leaves the checkpoint unchanged", async (t) => {
  const stored = { etag: ETAG_STORED, newest_event_id: "100" };
  const h = cycleHarness(t, { checkpoint: stored });
  const failure = new Error("transport closed");
  h.answers.next = async () => {
    throw failure;
  };
  await assert.rejects(h.cycle(), failure);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

test("a cancelled context aborts the request and commits nothing after the answer", async (t) => {
  const h = cycleHarness(t);
  const context = new CancellationContext();
  h.answers.next = async () => {
    context.cancel();
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  assert.equal(await h.cycle(context), CycleOutcome.Continue);
  assert.equal(h.calls[0]?.call.signal.aborted, true);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function loopHarness(t: TestContext, options: HarnessOptions = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = cycleHarness(t, options);
  const shutdown = new CancellationContext();
  const loops = new PollLoops({
    ...h.dependencies,
    context: shutdown,
    pollIntervalMs: INTERVAL_MS,
  });
  t.after(() => loops.stopAll());
  const interval = async () => {
    t.mock.timers.tick(INTERVAL_MS);
    await settle();
  };
  return { ...h, loops, interval };
}

test("a loop waits one interval before each cycle and re-arms after the cycle ends", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  t.mock.timers.tick(INTERVAL_MS - ONE_MS);
  await settle();
  assert.equal(h.calls.length, NO_CALLS);
  t.mock.timers.tick(ONE_MS);
  await settle();
  assert.equal(h.calls.length, ONE_CALL);
  await h.interval();
  assert.equal(h.calls.length, TWO_CALLS);
});

test("a slow request starts no second request of that inbound before it ends", async (t) => {
  const h = loopHarness(t);
  const slow = Promise.withResolvers<EventsAnswer>();
  h.answers.next = () => slow.promise;
  h.loops.start(h.inboundId);
  await h.interval();
  await h.interval();
  await h.interval();
  assert.equal(h.calls.length, ONE_CALL);
  slow.resolve(modified(ETAG_FIRST, []));
  await settle();
  assert.equal(h.calls.length, ONE_CALL);
  h.answers.next = async () => modified(ETAG_FIRST, []);
  await h.interval();
  assert.equal(h.calls.length, TWO_CALLS);
});

test("a thrown cycle logs the inbound and the code, and the loop continues", async (t) => {
  const h = loopHarness(t);
  h.answers.next = async () => {
    throw new Error("transport closed");
  };
  h.loops.start(h.inboundId);
  await h.interval();
  assert.equal(h.warn.mock.callCount(), ONE_CALL);
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, { inbound_id: h.inboundId, code: UNKNOWN_CODE });
  await h.interval();
  assert.equal(h.calls.length, TWO_CALLS);
  assert.deepEqual(h.drops, [CREDENTIAL, CREDENTIAL]);
});

test("a gone inbound ends its loop", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
  const transaction = t.mock.method(h.store, "transaction");
  await h.interval();
  assert.equal(transaction.mock.callCount(), ONE_CALL);
  await h.interval();
  assert.equal(transaction.mock.callCount(), ONE_CALL);
  assert.equal(h.calls.length, NO_CALLS);
  assert.deepEqual(h.grants, []);
});

test("a second start adds no loop and a stop clears the timer", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  h.loops.start(h.inboundId);
  await h.interval();
  assert.equal(h.calls.length, ONE_CALL);
  h.loops.stop(h.inboundId);
  await h.interval();
  assert.equal(h.calls.length, ONE_CALL);
});

test("stopAll cancels the running request, awaits its cycle and commits nothing", async (t) => {
  const h = loopHarness(t);
  const slow = Promise.withResolvers<EventsAnswer>();
  h.answers.next = () => slow.promise;
  h.loops.start(h.inboundId);
  await h.interval();
  assert.equal(h.calls.length, ONE_CALL);
  const stopped = h.loops.stopAll();
  assert.equal(h.calls[0]?.call.signal.aborted, true);
  slow.resolve(modified(ETAG_FIRST, [ev("101", "PushEvent")]));
  await stopped;
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  await h.interval();
  assert.equal(h.calls.length, ONE_CALL);
});
