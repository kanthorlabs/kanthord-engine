import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import pino from "pino";
import {
  GrantKind,
  type GrantOf,
  type GrantRequest,
  InboundOperation,
  type Material,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { createIdentity } from "../kernel/identity.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  type ClientOptions,
  type OperationResult,
  OperationResultType,
} from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import type {
  GitHubAnswer,
  GitHubCall,
  GitHubEvent,
  GitHubEventsAnswer,
  GitHubEventsQuery,
} from "../repository/github.ts";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  INTAKE_SERVICE_NAME,
  PLATFORM_CALL_DEADLINE_MS,
  ResourceKind,
  ResultClass,
} from "./contract.ts";
import { insertEvent } from "./event-store.ts";
import {
  allocateInboundId,
  deleteInbound,
  insertInbound,
} from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import {
  CycleAnswer,
  CycleOutcome,
  pollCycle,
  type PollCycleDependencies,
  PollLoops,
  PollRead,
  storeBatch,
} from "./poll.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const RESOURCE = "owner/repo";
const CREATE_EVENT_ID = "23984532267";
const PULL_REQUEST_EVENT_ID = "17268923405";
const ETAG_STORED = '"etag-0"';
const ETAG_FIRST = '"etag-1"';
const ETAG_SECOND = '"etag-2"';
const PULLS_ETAG_FIRST = '"pulls-1"';
const COMMENTS_ETAG_FIRST = '"comments-1"';
const CLOSED_AT = "2026-10-15T03:57:51Z";
const LATER_CLOSED_AT = "2026-10-15T04:10:00Z";
const SMALL_LIMIT = 2;
const TIGHT_LIMIT = 1;
const LARGE_LIMIT = 100;
const TOKEN = "ghp_poll-token";
const RETRYABLE_CODE = "repository.platform.github.retryable_refusal";
const SERVER_ERROR_STATUS = 500;
const UNRESOLVED_REQUESTS = 2;
const NO_REQUESTS = 0;
const SKIPPED_CYCLES = 2;
const RESOURCE_IDENTITY = "repository:github:owner/repo";
const DEMAND_FAILURE_CODE = "mission.authorization.refused";
const RATE_LIMIT_STATUS = 403;
const BACKOFF_INTERVAL_MS = 300000;
const BACKOFF_MAX_MS = 900000;
const WAKES_WITHOUT_EVENTS = 0;
const UNSENT_REQUEST_COUNT = 0;
const WAKES_PER_BATCH = 1;
const WARNINGS_PER_FAILURE = 1;
const REQUESTS_PER_CYCLE = 1;
const REQUESTS_AFTER_REARM = 2;
const INTERVAL_MS = 1000;
const TICK_MS = 1;
const ARMS_AT_START = 1;
const REARMS_PER_CYCLE = 1;
const SETTLE_TURNS = 20;
const UNKNOWN_CODE = "system.operation.unknown";
const SERVICE_IDENTITY = {
  kind: IdentityKind.Service,
  service: INTAKE_SERVICE_NAME,
} as const;

type EventsAnswer = GitHubAnswer<GitHubEventsAnswer>;

interface HarnessOptions {
  limit?: number;
  checkpoint?: unknown;
  intervalMs?: number;
  resourceKind?: ResourceKind;
}

function ev(id: string, type: string): GitHubEvent {
  return {
    id,
    type,
    body: new Uint8Array(Buffer.from(JSON.stringify({ id, type }))),
  };
}

function closedPull(number: number, closedAt: string): GitHubEvent {
  const id = `pull_request:${number}:${closedAt}`;
  return {
    id,
    type: "pull_request_closed",
    body: new Uint8Array(Buffer.from(JSON.stringify({ number }))),
  };
}

function harness(t: TestContext, options: HarnessOptions = {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
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
      configuration: {
        resource_kind: options.resourceKind ?? ResourceKind.Repository,
        resource: RESOURCE,
      },
      checkpoint: options.checkpoint ?? null,
      created_at: 1,
    }),
  );
  const batch = (
    etag: string | null,
    events: GitHubEvent[],
    read: PollRead = PollRead.Events,
  ) =>
    store.transaction((tx) =>
      storeBatch(tx, limit, inboundId, read, { etag, events }),
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
  const insertOrder = () =>
    store.transaction((tx) =>
      (
        tx.database
          .prepare("SELECT event_id FROM intake_inbound_event ORDER BY rowid")
          .all() as { event_id: string }[]
      ).map((row) => row.event_id),
    );
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
    insertOrder,
    addEvent,
    settleAll,
  };
}

test("an event with an id below an earlier event id is stored", (t) => {
  const h = harness(t);
  h.batch(ETAG_FIRST, [ev(CREATE_EVENT_ID, "CreateEvent")]);
  assert.deepEqual(h.eventIds(), [CREATE_EVENT_ID]);
  h.batch(ETAG_SECOND, [
    ev(PULL_REQUEST_EVENT_ID, "PullRequestEvent"),
    ev(CREATE_EVENT_ID, "CreateEvent"),
  ]);
  assert.deepEqual(h.eventIds().sort(), [
    PULL_REQUEST_EVENT_ID,
    CREATE_EVENT_ID,
  ]);
  assert.deepEqual(h.insertOrder(), [CREATE_EVENT_ID, PULL_REQUEST_EVENT_ID]);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_SECOND, pulls_etag: null });
});

test("a second answer with the same events stores nothing new", (t) => {
  const h = harness(t);
  const page = [
    ev(PULL_REQUEST_EVENT_ID, "PullRequestEvent"),
    ev(CREATE_EVENT_ID, "CreateEvent"),
  ];
  h.batch(ETAG_FIRST, page);
  const stored = h.insertOrder();
  h.batch(ETAG_SECOND, page);
  assert.deepEqual(h.insertOrder(), stored);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_SECOND, pulls_etag: null });
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
  assert.deepEqual(h.checkpoint(), { etag: null, pulls_etag: null });
  h.settleAll();
  h.batch(ETAG_FIRST, list);
  assert.deepEqual(h.eventIds(), ["100", "101", "102"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    pulls_etag: null,
  });
});

test("a second close of a pull request stores a second event", (t) => {
  const h = harness(t);
  h.batch(
    PULLS_ETAG_FIRST,
    [closedPull(41, CLOSED_AT)],
    PollRead.ClosedPullRequests,
  );
  h.batch(
    PULLS_ETAG_FIRST,
    [closedPull(41, LATER_CLOSED_AT), closedPull(41, CLOSED_AT)],
    PollRead.ClosedPullRequests,
  );
  assert.deepEqual(h.eventIds(), [
    `pull_request:41:${CLOSED_AT}`,
    `pull_request:41:${LATER_CLOSED_AT}`,
  ]);
});

function modified(etag: string | null, events: GitHubEvent[]): EventsAnswer {
  return { ok: true, value: { notModified: false, etag, events } };
}

function counted(
  count: number,
): OperationResult<{ count: number; link_count: number; inbox: boolean }> {
  return {
    type: OperationResultType.Completed,
    status: HttpStatus.OK,
    data: { count, link_count: NO_REQUESTS, inbox: false },
  };
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
  const pullCalls: { call: GitHubCall; query: GitHubEventsQuery }[] = [];
  const answers: { next: () => Promise<EventsAnswer> } = {
    next: async () => modified(ETAG_FIRST, []),
  };
  const pullAnswers: { next: () => Promise<EventsAnswer> } = {
    next: async () => ({ ok: true, value: { notModified: true } }),
  };
  const demands: {
    inputs: { project_id: string; resource_identity: string }[];
    options: ClientOptions[];
    next: () => Promise<
      OperationResult<{ count: number; link_count: number; inbox: boolean }>
    >;
  } = {
    inputs: [],
    options: [],
    next: async () => counted(UNRESOLVED_REQUESTS),
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
      listClosedPullRequests: async (call, query) => {
        pullCalls.push({ call, query });
        return pullAnswers.next();
      },
      listIssueComments: async () => modified(COMMENTS_ETAG_FIRST, []),
    },
    unresolvedRequests: async (input, options) => {
      demands.inputs.push(input);
      demands.options.push(options);
      return demands.next();
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
    pullCalls,
    answers,
    pullAnswers,
    demands,
    warn,
    wakes,
    dependencies,
    cycle,
  };
}

test("a cycle releases one poll grant for each request, requests the events under a deadline, stores the batch and wakes", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  assert.equal((await h.cycle()).outcome, CycleOutcome.Continue);
  assert.deepEqual(h.eventIds(), ["101"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    pulls_etag: null,
  });
  assert.equal(h.wakes.count, WAKES_PER_BATCH);
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
  const [{ call, query }] = h.calls as [(typeof h.calls)[number]];
  assert.deepEqual(query, { owner: "owner", repo: "repo", etag: null });
  assert.equal(call.token, TOKEN);
  assert.equal(call.requester, SERVICE_IDENTITY);
  assert.ok(call.deadlineAt <= Date.now() + PLATFORM_CALL_DEADLINE_MS);
  const grant = {
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
  };
  assert.deepEqual(h.grants, [grant, grant]);
  assert.deepEqual(h.drops, [CREDENTIAL, CREDENTIAL]);
});

test("a cycle at the bound sends no request and releases nothing, and it resumes below the bound", async (t) => {
  const h = cycleHarness(t, { limit: TIGHT_LIMIT });
  h.addEvent("50");
  assert.equal((await h.cycle()).outcome, CycleOutcome.Continue);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.deepEqual(h.grants, []);
  h.settleAll();
  await h.cycle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
});

test("a bound reached between the request and the commit leaves the new events unstored and writes a null ETag", async (t) => {
  const h = cycleHarness(t, {
    limit: TIGHT_LIMIT,
    checkpoint: { etag: ETAG_STORED, pulls_etag: null },
  });
  h.answers.next = async () => {
    h.addEvent("50");
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  await h.cycle();
  assert.deepEqual(h.eventIds(), ["50"]);
  assert.deepEqual(h.checkpoint(), { etag: null, pulls_etag: null });
});

test("a delete of the inbound before the commit stores no event and answers gone", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => {
    h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  assert.equal((await h.cycle()).outcome, CycleOutcome.Gone);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.wakes.count, WAKES_WITHOUT_EVENTS);
  assert.equal((await h.cycle()).outcome, CycleOutcome.Gone);
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
});

test("a store failure leaves the checkpoint unchanged and drops the material", async (t) => {
  const stored = { etag: ETAG_STORED, pulls_etag: null };
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
  const stored = { etag: ETAG_STORED, pulls_etag: null };
  const h = cycleHarness(t, { checkpoint: stored });
  h.answers.next = async () => ({
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: RETRYABLE_CODE,
    status: SERVER_ERROR_STATUS,
    message: "Server Error",
  });
  assert.equal((await h.cycle()).outcome, CycleOutcome.Continue);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.drops, [CREDENTIAL, CREDENTIAL]);
  assert.equal(h.warn.mock.callCount(), WARNINGS_PER_FAILURE);
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, { inbound_id: h.inboundId, code: RETRYABLE_CODE });
  assert.ok(!JSON.stringify(h.warn.mock.calls).includes(TOKEN));
});

test("a thrown request drops the material and leaves the checkpoint unchanged", async (t) => {
  const stored = { etag: ETAG_STORED, pulls_etag: null };
  const h = cycleHarness(t, { checkpoint: stored });
  const failure = new Error("transport closed");
  h.answers.next = async () => {
    throw failure;
  };
  await assert.rejects(h.cycle(), failure);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.drops, [CREDENTIAL]);
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

async function until(done: () => boolean, signal: AbortSignal): Promise<void> {
  while (!done()) await turn(undefined, { signal });
}

async function reaches(
  count: () => number,
  expected: number,
  signal: AbortSignal,
): Promise<void> {
  await until(() => count() >= expected, signal);
  assert.equal(count(), expected);
}

function loopHarness(t: TestContext, options: HarnessOptions = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const arms = t.mock.method(globalThis, "setTimeout");
  const h = cycleHarness(t, options);
  const shutdown = new CancellationContext();
  const intervalMs = options.intervalMs ?? INTERVAL_MS;
  const loops = new PollLoops({
    ...h.dependencies,
    context: shutdown,
    pollIntervalMs: intervalMs,
  });
  stopAfter(t, () => loops.stopAll());
  const elapse = (ms: number) => t.mock.timers.tick(ms);
  const interval = () => elapse(intervalMs);
  const rearmed = (count: number) =>
    reaches(() => arms.mock.callCount(), ARMS_AT_START + count, t.signal);
  const script = (answers: EventsAnswer[]) => {
    h.answers.next = async () =>
      answers.shift() ?? { ok: true, value: { notModified: true } };
  };
  return {
    ...h,
    loops,
    interval,
    elapse,
    rearmed,
    script,
  };
}

function limited(waitMs: number | null): EventsAnswer {
  return {
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: RETRYABLE_CODE,
    status: RATE_LIMIT_STATUS,
    message: "rate limited",
    rate_limit: { wait_ms: waitMs },
  };
}

function unchanged(): EventsAnswer {
  return { ok: true, value: { notModified: true } };
}

test("a slow request starts no second request of that inbound before it ends", async (t) => {
  const h = loopHarness(t);
  const slow = Promise.withResolvers<EventsAnswer>();
  h.answers.next = () => slow.promise;
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.interval();
  await settle();
  h.interval();
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
  slow.resolve(modified(ETAG_FIRST, []));
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
  h.answers.next = async () => modified(ETAG_FIRST, []);
  await h.rearmed(REARMS_PER_CYCLE);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("a thrown cycle logs the inbound and the code, and the loop continues", async (t) => {
  const h = loopHarness(t);
  h.answers.next = async () => {
    throw new Error("transport closed");
  };
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.warn.mock.callCount(), WARNINGS_PER_FAILURE, t.signal);
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, { inbound_id: h.inboundId, code: UNKNOWN_CODE });
  await h.rearmed(REARMS_PER_CYCLE);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
  const dropped = [CREDENTIAL, CREDENTIAL];
  await until(() => h.drops.length >= dropped.length, t.signal);
  assert.deepEqual(h.drops, dropped);
});

test("a second start adds no loop and a stop clears the timer", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.loops.stop(h.inboundId);
  h.interval();
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
});

test("stopAll cancels the running request, awaits its cycle and commits nothing", async (t) => {
  const h = loopHarness(t);
  const slow = Promise.withResolvers<EventsAnswer>();
  h.answers.next = () => slow.promise;
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  const stopped = h.loops.stopAll();
  assert.equal(h.calls[0]?.call.signal.aborted, true);
  slow.resolve(modified(ETAG_FIRST, [ev("101", "PushEvent")]));
  await stopped;
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.checkpoint(), null);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  h.interval();
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
});

test("a refusal that names a wait delays the next request until that wait", async (t) => {
  const h = loopHarness(t);
  h.script([limited(5 * INTERVAL_MS)]);
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(5 * INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("secondary rate limit refusals double the wait up to the bound, and the next answer returns to the interval", async (t) => {
  const h = loopHarness(t, { intervalMs: BACKOFF_INTERVAL_MS });
  h.script([limited(null), limited(null), limited(null), unchanged()]);
  h.loops.start(h.inboundId);
  h.interval();
  let requests = REQUESTS_PER_CYCLE;
  let rearms = REARMS_PER_CYCLE;
  await reaches(() => h.calls.length, requests, t.signal);
  for (const waitMs of [
    2 * BACKOFF_INTERVAL_MS,
    BACKOFF_MAX_MS,
    BACKOFF_MAX_MS,
    BACKOFF_INTERVAL_MS,
  ]) {
    await h.rearmed(rearms);
    h.elapse(waitMs - TICK_MS);
    await settle();
    assert.equal(h.calls.length, requests);
    h.elapse(TICK_MS);
    requests += REQUESTS_PER_CYCLE;
    rearms += REARMS_PER_CYCLE;
    await reaches(() => h.calls.length, requests, t.signal);
  }
  await h.rearmed(rearms);
  h.elapse(BACKOFF_INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, requests);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, requests + REQUESTS_PER_CYCLE, t.signal);
});

test("a cycle asks for the unresolved request count of the project and the resource identity before the release", async (t) => {
  const h = cycleHarness(t);
  assert.equal((await h.cycle()).answer, CycleAnswer.Answered);
  assert.deepEqual(h.demands.inputs, [
    { project_id: PROJECT_ID, resource_identity: RESOURCE_IDENTITY },
  ]);
  assert.equal(h.demands.options[0]?.identity, SERVICE_IDENTITY);
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
});

test("a count of zero sends no request, releases nothing and keeps the checkpoint", async (t) => {
  const stored = { etag: ETAG_STORED, pulls_etag: null };
  const h = cycleHarness(t, { checkpoint: stored });
  h.demands.next = async () => counted(NO_REQUESTS);
  const result = await h.cycle();
  assert.equal(result.outcome, CycleOutcome.Continue);
  assert.equal(result.answer, CycleAnswer.Skipped);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.deepEqual(h.grants, []);
  assert.deepEqual(h.drops, []);
  assert.deepEqual(h.checkpoint(), stored);
  assert.equal(h.warn.mock.callCount(), NO_REQUESTS);
});

test("a failed count call skips the request and logs the reason", async (t) => {
  const stored = { etag: ETAG_STORED, pulls_etag: null };
  const h = cycleHarness(t, { checkpoint: stored });
  h.demands.next = async () => ({
    type: OperationResultType.Failure,
    status: HttpStatus.Forbidden,
    error: {
      error: {
        code: DEMAND_FAILURE_CODE,
        message: "refused",
        details: null,
      },
      request_id: createIdentity("request"),
    },
  });
  assert.equal((await h.cycle()).answer, CycleAnswer.Skipped);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.deepEqual(h.grants, []);
  assert.deepEqual(h.checkpoint(), stored);
  assert.equal(h.warn.mock.callCount(), WARNINGS_PER_FAILURE);
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, {
    inbound_id: h.inboundId,
    code: DEMAND_FAILURE_CODE,
  });
  h.demands.next = async () => ({ type: OperationResultType.Indeterminate });
  assert.equal((await h.cycle()).answer, CycleAnswer.Skipped);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.equal(h.warn.mock.callCount(), SKIPPED_CYCLES * WARNINGS_PER_FAILURE);
});

test("an inbound deleted between the count and the release ends the cycle with no request", async (t) => {
  const h = cycleHarness(t);
  h.demands.next = async () => {
    h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
    return counted(UNRESOLVED_REQUESTS);
  };
  assert.equal((await h.cycle()).outcome, CycleOutcome.Gone);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.deepEqual(h.grants, []);
});

function failed(status: number): EventsAnswer {
  return {
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: RETRYABLE_CODE,
    status,
    message: "failed",
  };
}

test("a rate limit refusal of the events read ends the cycle with no closed pull request read", async (t) => {
  for (const waitMs of [null, 5 * INTERVAL_MS]) {
    const h = cycleHarness(t);
    h.answers.next = async () => limited(waitMs);
    const result = await h.cycle();
    assert.equal(result.outcome, CycleOutcome.Continue);
    assert.equal(h.pullCalls.length, UNSENT_REQUEST_COUNT);
    assert.equal(h.grants.length, REQUESTS_PER_CYCLE);
    assert.deepEqual(h.drops, [CREDENTIAL]);
  }
});

test("a failed closed pull request read logs its code and keeps the checkpoint after a 200 events read", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  h.pullAnswers.next = async () => failed(SERVER_ERROR_STATUS);
  assert.equal((await h.cycle()).answer, CycleAnswer.Answered);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_FIRST, pulls_etag: null });
  const [fields] = h.warn.mock.calls[0]?.arguments ?? [];
  assert.deepEqual(fields, { inbound_id: h.inboundId, code: RETRYABLE_CODE });
});
