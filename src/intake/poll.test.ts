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
import { OperationError } from "../kernel/errors.ts";
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
  CycleAnswer,
  CycleOutcome,
  pollCycle,
  type PollCycleDependencies,
  PollLoops,
  PollRead,
  storeBatch,
} from "./poll.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const RESOURCE = "owner/repo";
const CREATE_EVENT_ID = "23984532267";
const PULL_REQUEST_EVENT_ID = "17268923405";
const ETAG_STORED = '"etag-0"';
const ETAG_FIRST = '"etag-1"';
const ETAG_SECOND = '"etag-2"';
const PULLS_ETAG_STORED = '"pulls-0"';
const PULLS_ETAG_FIRST = '"pulls-1"';
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
const POLL_READS_PER_CYCLE = 2;
const RESOURCE_IDENTITY = "repository:github:owner/repo";
const DEMAND_FAILURE_CODE = "mission.authorization.refused";
const RATE_LIMIT_STATUS = 403;
const BACKOFF_INTERVAL_MS = 300000;
const BACKOFF_MAX_MS = 900000;
const WAIT_MAX_MS = 3600000;
const WAKES_WITHOUT_EVENTS = 0;
const UNSENT_REQUEST_COUNT = 0;
const WAKES_PER_BATCH = 1;
const WARNINGS_PER_FAILURE = 1;
const TRANSACTIONS_OF_GONE_LOOP = 1;
const REQUESTS_PER_CYCLE = 1;
const REQUESTS_AFTER_REARM = 2;
const INTERVAL_MS = 1000;
const SPREAD_OFFSETS_MS = [0, 333, 666];
const HARNESS_LOOP_COUNT = 1;
const LOOPS_PER_OFFSET = 1;
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

test("a batch inserts every event of the page, oldest of the page first, and writes the checkpoint", (t) => {
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
  assert.deepEqual(h.insertOrder(), ["101", "102"]);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_FIRST, pulls_etag: null });
});

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

test("a stored checkpoint that holds newest_event_id loads, and the next write drops it", (t) => {
  const h = harness(t, {
    checkpoint: {
      etag: ETAG_STORED,
      newest_event_id: CREATE_EVENT_ID,
    },
  });
  h.batch(ETAG_FIRST, [
    ev(PULL_REQUEST_EVENT_ID, "PullRequestEvent"),
    ev(CREATE_EVENT_ID, "CreateEvent"),
  ]);
  assert.deepEqual(h.eventIds().sort(), [
    PULL_REQUEST_EVENT_ID,
    CREATE_EVENT_ID,
  ]);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_FIRST, pulls_etag: null });
});

test("an empty answer and an answer of known events store the ETag", (t) => {
  const h = harness(t, {
    checkpoint: { etag: ETAG_STORED, pulls_etag: null },
  });
  h.batch(ETAG_FIRST, []);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_FIRST, pulls_etag: null });
  h.addEvent("101");
  h.addEvent("100");
  h.batch(ETAG_SECOND, [ev("101", "PushEvent"), ev("100", "PushEvent")]);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_SECOND, pulls_etag: null });
  assert.deepEqual(h.eventIds(), ["100", "101"]);
});

test("a repeated event identity inserts no row", (t) => {
  const h = harness(t);
  h.addEvent("101");
  h.batch(ETAG_FIRST, [ev("102", "PushEvent"), ev("101", "PushEvent")]);
  assert.deepEqual(h.eventIds(), ["101", "102"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    pulls_etag: null,
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
  assert.deepEqual(h.checkpoint(), { etag: null, pulls_etag: null });
  h.settleAll();
  h.batch(ETAG_FIRST, list);
  assert.deepEqual(h.eventIds(), ["100", "101", "102"]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    pulls_etag: null,
  });
});

test("a batch of a deleted inbound stores nothing and answers false", (t) => {
  const h = harness(t);
  h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
  assert.equal(h.batch(ETAG_FIRST, [ev("101", "PushEvent")]), false);
  assert.deepEqual(h.eventIds(), []);
});

test("a closed pull request batch inserts its items, writes pulls_etag and keeps the etag", (t) => {
  const h = harness(t, {
    checkpoint: { etag: ETAG_STORED, pulls_etag: null },
  });
  assert.equal(
    h.batch(
      PULLS_ETAG_FIRST,
      [closedPull(42, LATER_CLOSED_AT), closedPull(41, CLOSED_AT)],
      PollRead.ClosedPullRequests,
    ),
    true,
  );
  assert.deepEqual(h.insertOrder(), [
    `pull_request:41:${CLOSED_AT}`,
    `pull_request:42:${LATER_CLOSED_AT}`,
  ]);
  assert.deepEqual(
    h.events().map((row) => row.metadata),
    [{ event: "pull_request_closed" }, { event: "pull_request_closed" }],
  );
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_STORED,
    pulls_etag: PULLS_ETAG_FIRST,
  });
});

test("an events batch keeps pulls_etag", (t) => {
  const h = harness(t, {
    checkpoint: { etag: ETAG_STORED, pulls_etag: PULLS_ETAG_STORED },
  });
  h.batch(ETAG_FIRST, [ev("101", "PushEvent")]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_FIRST,
    pulls_etag: PULLS_ETAG_STORED,
  });
});

test("a stored checkpoint without pulls_etag loads with a null pulls_etag, and a write adds the field", (t) => {
  const h = harness(t, { checkpoint: { etag: ETAG_STORED } });
  h.batch(PULLS_ETAG_FIRST, [], PollRead.ClosedPullRequests);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_STORED,
    pulls_etag: PULLS_ETAG_FIRST,
  });
});

test("a closed pull request item that is already stored inserts no second row", (t) => {
  const h = harness(t);
  const page = [closedPull(41, CLOSED_AT)];
  h.batch(PULLS_ETAG_FIRST, page, PollRead.ClosedPullRequests);
  const stored = h.insertOrder();
  h.batch(PULLS_ETAG_FIRST, page, PollRead.ClosedPullRequests);
  assert.deepEqual(h.insertOrder(), stored);
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

test("a closed pull request page that exceeds the room writes a null pulls_etag and keeps the etag", (t) => {
  const h = harness(t, {
    limit: SMALL_LIMIT,
    checkpoint: { etag: ETAG_STORED, pulls_etag: PULLS_ETAG_STORED },
  });
  h.batch(
    PULLS_ETAG_FIRST,
    [
      closedPull(43, LATER_CLOSED_AT),
      closedPull(42, LATER_CLOSED_AT),
      closedPull(41, CLOSED_AT),
    ],
    PollRead.ClosedPullRequests,
  );
  assert.equal(h.eventIds().length, SMALL_LIMIT);
  assert.deepEqual(h.checkpoint(), { etag: ETAG_STORED, pulls_etag: null });
});

function modified(etag: string | null, events: GitHubEvent[]): EventsAnswer {
  return { ok: true, value: { notModified: false, etag, events } };
}

function counted(count: number): OperationResult<{ count: number }> {
  return {
    type: OperationResultType.Completed,
    status: HttpStatus.OK,
    data: { count },
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
    next: () => Promise<OperationResult<{ count: number }>>;
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

test("a 304 answer commits nothing and the request carries the stored ETag", async (t) => {
  const stored = { etag: ETAG_STORED, pulls_etag: null };
  const h = cycleHarness(t, { checkpoint: stored });
  h.answers.next = async () => ({ ok: true, value: { notModified: true } });
  assert.equal((await h.cycle()).outcome, CycleOutcome.Continue);
  assert.equal(h.calls[0]?.query.etag, ETAG_STORED);
  assert.deepEqual(h.checkpoint(), stored);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.wakes.count, WAKES_WITHOUT_EVENTS);
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
  assert.deepEqual(h.checkpoint(), { etag: null, pulls_etag: null });
  await h.cycle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
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

test("a cancelled context aborts the request and commits nothing after the answer", async (t) => {
  const h = cycleHarness(t);
  const context = new CancellationContext();
  h.answers.next = async () => {
    context.cancel();
    return modified(ETAG_FIRST, [ev("101", "PushEvent")]);
  };
  assert.equal((await h.cycle(context)).outcome, CycleOutcome.Continue);
  assert.equal(h.calls[0]?.call.signal.aborted, true);
  assert.deepEqual(h.eventIds(), []);
  assert.equal(h.checkpoint(), null);
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
  t.after(() => loops.stopAll());
  const elapse = (ms: number) => t.mock.timers.tick(ms);
  const interval = () => elapse(intervalMs);
  const rearmed = (count: number) =>
    reaches(() => arms.mock.callCount(), ARMS_AT_START + count, t.signal);
  const script = (answers: EventsAnswer[]) => {
    h.answers.next = async () =>
      answers.shift() ?? { ok: true, value: { notModified: true } };
  };
  const scriptPulls = (answers: EventsAnswer[]) => {
    h.pullAnswers.next = async () =>
      answers.shift() ?? { ok: true, value: { notModified: true } };
  };
  return { ...h, loops, interval, elapse, rearmed, script, scriptPulls };
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

function unchanged(pollIntervalMs?: number): EventsAnswer {
  return {
    ok: true,
    value: {
      notModified: true,
      ...(pollIntervalMs === undefined
        ? {}
        : { poll_interval_ms: pollIntervalMs }),
    },
  };
}

test("a loop waits one interval before each cycle and re-arms after the cycle ends", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  t.mock.timers.tick(INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  t.mock.timers.tick(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(REARMS_PER_CYCLE);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("startAll spreads the first cycles of the loops across one interval", async (t) => {
  const h = loopHarness(t);
  const extra = SPREAD_OFFSETS_MS.slice(HARNESS_LOOP_COUNT).map(() => {
    const id = allocateInboundId();
    h.store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind: InboundKind.Poll,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: CREDENTIAL,
        configuration: { resource: RESOURCE },
        checkpoint: null,
        created_at: 1,
      }),
    );
    return id;
  });
  const ids = [h.inboundId, ...extra];
  const polled = () => [
    ...new Set(
      h.grants.map((grant) =>
        grant.kind === GrantKind.Inbound ? grant.inbound.inboundId : null,
      ),
    ),
  ];
  h.loops.startAll(ids);
  let elapsedMs = 0;
  for (const [index, offsetMs] of SPREAD_OFFSETS_MS.entries()) {
    t.mock.timers.tick(INTERVAL_MS + offsetMs - TICK_MS - elapsedMs);
    await settle();
    assert.deepEqual(polled(), ids.slice(0, index));
    t.mock.timers.tick(TICK_MS);
    await until(() => polled().length >= index + LOOPS_PER_OFFSET, t.signal);
    assert.deepEqual(polled(), ids.slice(0, index + LOOPS_PER_OFFSET));
    elapsedMs = INTERVAL_MS + offsetMs;
  }
});

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

test("a gone inbound ends its loop", async (t) => {
  const h = loopHarness(t);
  h.loops.start(h.inboundId);
  h.store.transaction((tx) => deleteInbound(tx, h.inboundId));
  const transaction = t.mock.method(h.store, "transaction");
  h.interval();
  await reaches(
    () => transaction.mock.callCount(),
    TRANSACTIONS_OF_GONE_LOOP,
    t.signal,
  );
  await settle();
  h.interval();
  await settle();
  assert.equal(transaction.mock.callCount(), TRANSACTIONS_OF_GONE_LOOP);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.deepEqual(h.grants, []);
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

test("a refusal that names a wait below the interval waits one interval", async (t) => {
  const h = loopHarness(t);
  h.script([limited(0)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(INTERVAL_MS - TICK_MS);
  await settle();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("an X-Poll-Interval above the interval delays the next request, and one below it changes nothing", async (t) => {
  const h = loopHarness(t);
  h.script([unchanged(3 * INTERVAL_MS), unchanged(INTERVAL_MS / 2)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(3 * INTERVAL_MS - TICK_MS);
  await settle();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
  await h.rearmed(2 * REARMS_PER_CYCLE);
  h.elapse(INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, REQUESTS_AFTER_REARM);
  h.elapse(TICK_MS);
  await reaches(
    () => h.calls.length,
    REQUESTS_AFTER_REARM + REQUESTS_PER_CYCLE,
    t.signal,
  );
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

test("any answer ends the count of secondary rate limit refusals", async (t) => {
  const h = loopHarness(t);
  h.script([limited(null), limited(null), unchanged(), limited(null)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS);
  await h.rearmed(2 * REARMS_PER_CYCLE);
  h.elapse(4 * INTERVAL_MS);
  await h.rearmed(3 * REARMS_PER_CYCLE);
  h.elapse(INTERVAL_MS);
  await reaches(() => h.calls.length, 4 * REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(4 * REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, 4 * REQUESTS_PER_CYCLE);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, 5 * REQUESTS_PER_CYCLE, t.signal);
});

test("a refusal that is no rate limit keeps the interval and ends the count", async (t) => {
  const h = loopHarness(t);
  h.script([
    limited(null),
    {
      ok: false,
      class: ResultClass.RetryableRefusal,
      code: RETRYABLE_CODE,
      status: SERVER_ERROR_STATUS,
      message: "Server Error",
    },
  ]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS);
  await h.rearmed(2 * REARMS_PER_CYCLE);
  h.elapse(INTERVAL_MS);
  await reaches(() => h.calls.length, 3 * REQUESTS_PER_CYCLE, t.signal);
});

test("the wait bound caps a named wait", async (t) => {
  const h = loopHarness(t);
  h.script([limited(10 * WAIT_MAX_MS)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(WAIT_MAX_MS - TICK_MS);
  await settle();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
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

test("a cycle at the capacity bound or for a gone inbound asks no count", async (t) => {
  const bounded = cycleHarness(t, { limit: TIGHT_LIMIT });
  bounded.addEvent("50");
  await bounded.cycle();
  assert.deepEqual(bounded.demands.inputs, []);
  const gone = cycleHarness(t);
  gone.store.transaction((tx) => deleteInbound(tx, gone.inboundId));
  assert.equal((await gone.cycle()).outcome, CycleOutcome.Gone);
  assert.deepEqual(gone.demands.inputs, []);
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

test("a loop skips the request while the count is zero, keeps the interval and requests again when the count rises", async (t) => {
  const h = loopHarness(t);
  h.demands.next = async () => counted(NO_REQUESTS);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.interval();
  await h.rearmed(2 * REARMS_PER_CYCLE);
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  await reaches(() => h.demands.inputs.length, SKIPPED_CYCLES, t.signal);
  h.demands.next = async () => counted(UNRESOLVED_REQUESTS);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
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

test("a cycle makes the closed pull request read after the events read with its own grant and its own ETag", async (t) => {
  const h = cycleHarness(t, {
    checkpoint: { etag: ETAG_STORED, pulls_etag: PULLS_ETAG_STORED },
  });
  const order: string[] = [];
  h.answers.next = async () => {
    order.push("events");
    return { ok: true, value: { notModified: true } };
  };
  h.pullAnswers.next = async () => {
    order.push("pulls");
    return { ok: true, value: { notModified: true } };
  };
  const result = await h.cycle();
  assert.equal(result.outcome, CycleOutcome.Continue);
  assert.deepEqual(order, ["events", "pulls"]);
  assert.equal(h.calls[0]?.query.etag, ETAG_STORED);
  assert.equal(h.pullCalls[0]?.query.etag, PULLS_ETAG_STORED);
  assert.deepEqual(h.pullCalls[0]?.query, {
    owner: "owner",
    repo: "repo",
    etag: PULLS_ETAG_STORED,
  });
  assert.equal(h.pullCalls[0]?.call.token, TOKEN);
  assert.ok(
    (h.pullCalls[0]?.call.deadlineAt ?? Number.POSITIVE_INFINITY) <=
      Date.now() + PLATFORM_CALL_DEADLINE_MS,
  );
  assert.equal(h.grants.length, POLL_READS_PER_CYCLE);
  assert.deepEqual(h.drops, [CREDENTIAL, CREDENTIAL]);
});

test("a cycle stores the closed pull request items under their own event id, wakes and keeps the etag", async (t) => {
  const h = cycleHarness(t, {
    checkpoint: { etag: ETAG_STORED, pulls_etag: null },
  });
  h.answers.next = async () => ({ ok: true, value: { notModified: true } });
  h.pullAnswers.next = async () =>
    modified(PULLS_ETAG_FIRST, [closedPull(41, CLOSED_AT)]);
  await h.cycle();
  assert.deepEqual(h.eventIds(), [`pull_request:41:${CLOSED_AT}`]);
  assert.deepEqual(h.checkpoint(), {
    etag: ETAG_STORED,
    pulls_etag: PULLS_ETAG_FIRST,
  });
  assert.equal(h.wakes.count, WAKES_PER_BATCH);
  assert.equal(h.pullCalls[0]?.query.etag, null);
});

test("a stored checkpoint without pulls_etag sends no If-None-Match on the closed pull request read", async (t) => {
  const h = cycleHarness(t, { checkpoint: { etag: ETAG_STORED } });
  await h.cycle();
  assert.equal(h.calls[0]?.query.etag, ETAG_STORED);
  assert.equal(h.pullCalls[0]?.query.etag, null);
});

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

test("another failure of the events read still runs the closed pull request read", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => failed(SERVER_ERROR_STATUS);
  h.pullAnswers.next = async () =>
    modified(PULLS_ETAG_FIRST, [closedPull(41, CLOSED_AT)]);
  const result = await h.cycle();
  assert.equal(result.answer, CycleAnswer.Answered);
  assert.equal(h.pullCalls.length, REQUESTS_PER_CYCLE);
  assert.deepEqual(h.eventIds(), [`pull_request:41:${CLOSED_AT}`]);
  assert.equal(h.warn.mock.callCount(), WARNINGS_PER_FAILURE);
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

test("an inbound deleted between the two reads ends the cycle", async (t) => {
  const h = cycleHarness(t);
  h.answers.next = async () => {
    const answer = modified(ETAG_FIRST, [ev("101", "PushEvent")]);
    queueMicrotask(() =>
      h.store.transaction((tx) => deleteInbound(tx, h.inboundId)),
    );
    return answer;
  };
  assert.equal((await h.cycle()).outcome, CycleOutcome.Gone);
  assert.equal(h.pullCalls.length, UNSENT_REQUEST_COUNT);
});

test("a secondary refusal of the closed pull request read after a 200 events read doubles the wait", async (t) => {
  const h = loopHarness(t);
  h.script([modified(ETAG_FIRST, [])]);
  h.scriptPulls([limited(null)]);
  h.loops.start(h.inboundId);
  h.interval();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  await reaches(() => h.pullCalls.length, REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, REQUESTS_PER_CYCLE);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("one count holds the secondary refusals of both reads", async (t) => {
  const h = loopHarness(t);
  h.script([limited(null)]);
  h.scriptPulls([limited(null)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  assert.equal(h.pullCalls.length, UNSENT_REQUEST_COUNT);
  h.elapse(2 * INTERVAL_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
  await reaches(() => h.pullCalls.length, REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(2 * REARMS_PER_CYCLE);
  h.elapse(4 * INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, REQUESTS_AFTER_REARM);
  h.elapse(TICK_MS);
  await reaches(
    () => h.calls.length,
    REQUESTS_AFTER_REARM + REQUESTS_PER_CYCLE,
    t.signal,
  );
});

test("a refusal that names a wait on the closed pull request read ends the count and delays the next cycle", async (t) => {
  const h = loopHarness(t);
  h.script([limited(null)]);
  h.scriptPulls([limited(3 * INTERVAL_MS), limited(null)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS);
  await reaches(() => h.pullCalls.length, REQUESTS_PER_CYCLE, t.signal);
  await h.rearmed(2 * REARMS_PER_CYCLE);
  h.elapse(3 * INTERVAL_MS - TICK_MS);
  await settle();
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
  h.elapse(TICK_MS);
  await reaches(
    () => h.calls.length,
    REQUESTS_AFTER_REARM + REQUESTS_PER_CYCLE,
    t.signal,
  );
  await reaches(() => h.pullCalls.length, REQUESTS_AFTER_REARM, t.signal);
  await h.rearmed(3 * REARMS_PER_CYCLE);
  h.elapse(2 * INTERVAL_MS - TICK_MS);
  await settle();
  assert.equal(h.calls.length, REQUESTS_AFTER_REARM + REQUESTS_PER_CYCLE);
  h.elapse(TICK_MS);
  await reaches(
    () => h.calls.length,
    REQUESTS_AFTER_REARM + REQUESTS_AFTER_REARM,
    t.signal,
  );
});

test("the wait after a cycle is the longest wait of both answers", async (t) => {
  const events = loopHarness(t);
  events.script([unchanged(5 * INTERVAL_MS)]);
  events.scriptPulls([unchanged(3 * INTERVAL_MS)]);
  events.loops.start(events.inboundId);
  events.interval();
  await events.rearmed(REARMS_PER_CYCLE);
  events.elapse(5 * INTERVAL_MS - TICK_MS);
  await settle();
  await reaches(() => events.calls.length, REQUESTS_PER_CYCLE, t.signal);
  events.elapse(TICK_MS);
  await reaches(() => events.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("a longer wait of the closed pull request read delays the next cycle", async (t) => {
  const h = loopHarness(t);
  h.script([unchanged(3 * INTERVAL_MS)]);
  h.scriptPulls([unchanged(5 * INTERVAL_MS)]);
  h.loops.start(h.inboundId);
  h.interval();
  await h.rearmed(REARMS_PER_CYCLE);
  h.elapse(5 * INTERVAL_MS - TICK_MS);
  await settle();
  await reaches(() => h.calls.length, REQUESTS_PER_CYCLE, t.signal);
  h.elapse(TICK_MS);
  await reaches(() => h.calls.length, REQUESTS_AFTER_REARM, t.signal);
});

test("a count of zero makes neither read", async (t) => {
  const h = cycleHarness(t);
  h.demands.next = async () => counted(NO_REQUESTS);
  await h.cycle();
  assert.equal(h.calls.length, UNSENT_REQUEST_COUNT);
  assert.equal(h.pullCalls.length, UNSENT_REQUEST_COUNT);
});
