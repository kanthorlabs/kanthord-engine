import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { ulid } from "ulid";
import {
  GrantKind,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import { CodedError } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  OperationRegistry,
  OperationResultType,
  type CallerContext,
} from "../kernel/operation.ts";
import { HealthStatus } from "../kernel/service.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  GitHubPlatform,
  type GitHubAnswer,
  type GitHubCheckpoint,
  type GitHubEvent,
  type GitHubEventsAnswer,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  type InboundCreate,
  type InboundKindValue,
} from "./contract.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { IntakeService } from "./index.ts";
import { intakeMigrations } from "./migrations.ts";
import { unusedActionDependencies } from "./test-support.ts";

const STOPPED_CODE = "intake.lifecycle.stopped";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const OTHER_CREDENTIAL = "github-other";
const CREATED_AT = 1000;
const NO_CALLS = 0;
const TWO_CALLS = 2;
const INTERVAL_MS = 1000;
const SETTLE_TURNS = 20;
const POLL_TOKEN = "ghp_poll-token";
const RESOURCE = "acme/app";
const ETAG_STORED = '"etag-0"';
const ETAG_FIRST = '"etag-1"';
const CLOSED_LOCAL_PORT = "http://127.0.0.1:9";

function identity(service: string): ServiceIdentity {
  return { kind: IdentityKind.Service, service };
}

function fixture(t: TestContext, service = INTAKE_SERVICE_NAME) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const health = new HealthRegistry();
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health,
    identity: identity(service),
    ...unusedActionDependencies(),
  });
  return { intake, health, store };
}

test("Intake runs each lifecycle phase once and refuses a restart", async (t) => {
  const { intake } = migratedFixture(t);
  const running = intake.run();
  assert.equal(await intake.quiesce(), null);
  await intake.drain();
  assert.equal(await intake.stop(), null);
  assert.equal(await running, null);
  const restart = await intake.start();
  assert.ok(restart instanceof CodedError);
  assert.equal(restart.code, STOPPED_CODE);
});

test("Intake start refuses the identity of another service", async (t) => {
  const { intake } = fixture(t, "mission");
  await assert.rejects(intake.start(), assert.AssertionError);
});

test("Intake probe answers 200 while running and 503 after stop", async (t) => {
  const { intake, health } = fixture(t);
  assert.deepEqual(await intake.healthcheck(), {
    events: HealthStatus.Unavailable,
  });
  assert.equal(await intake.start(), null);
  assert.deepEqual(await health.check(), {
    intake: { events: HealthStatus.Healthy },
  });
  assert.equal(await intake.stop(), null);
  assert.deepEqual(await health.check(), {
    intake: { events: HealthStatus.Unavailable },
  });
});

test("Intake answers no resource inventory entry", (t) => {
  const { intake, store } = fixture(t);
  assert.deepEqual(
    store.transaction((tx) => intake.resourceInventory(tx)),
    [],
  );
});

function insertNaming(
  store: Store,
  kind: InboundKindValue,
  credential: string | null,
  checkpoint: GitHubCheckpoint | null = null,
): string {
  const id = allocateInboundId();
  store.transaction((tx) =>
    insertInbound(tx, id, {
      project_id: PROJECT_ID,
      kind,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential,
      configuration: { resource: RESOURCE },
      checkpoint,
      created_at: CREATED_AT,
    }),
  );
  return id;
}

function migratedFixture(t: TestContext) {
  const h = fixture(t);
  h.store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return h;
}

test("inboundsNaming answers each inbound that names the credential", (t) => {
  const { intake, store } = migratedFixture(t);
  const first = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  const second = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  insertNaming(store, InboundKind.Poll, OTHER_CREDENTIAL);
  assert.deepEqual(
    store.transaction((tx) => intake.inboundsNaming(tx, CREDENTIAL)),
    [first, second].sort().map((inbound_id) => ({ inbound_id })),
  );
});

test("inboundsNaming answers no webhook inbound, which names no credential", (t) => {
  const { intake, store } = migratedFixture(t);
  insertNaming(store, InboundKind.Webhook, null);
  assert.deepEqual(
    store.transaction((tx) => intake.inboundsNaming(tx, CREDENTIAL)),
    [],
  );
});

test("inboundsNaming opens no transaction", (t) => {
  const { intake, store } = migratedFixture(t);
  const id = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  store.transaction((tx) => {
    const transactions = t.mock.method(store, "transaction");
    assert.deepEqual(intake.inboundsNaming(tx, CREDENTIAL), [
      { inbound_id: id },
    ]);
    assert.equal(transactions.mock.callCount(), NO_CALLS);
  });
});

type EventsAnswer = GitHubAnswer<GitHubEventsAnswer>;

function modified(etag: string | null, events: GitHubEvent[]): EventsAnswer {
  return { ok: true, value: { notModified: false, etag, events } };
}

function ev(id: string): GitHubEvent {
  return {
    id,
    type: "PushEvent",
    body: new Uint8Array(Buffer.from(JSON.stringify({ id }))),
  };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
}

function pollCustody(): IntakeCustody {
  return {
    custodySuitability: () => {},
    authorizeOperation<R extends GrantRequest>(
      _tx: unknown,
      request: R,
    ): GrantOf<R["kind"]> {
      const inbound: GrantRequest = request;
      assert.ok(inbound.kind === GrantKind.Inbound);
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
      return {
        credential_id: "credential_1",
        platform: grant.platform,
        value: () => ({ key: POLL_TOKEN }),
        drop: () => {},
      };
    },
    consume: () => assert.fail("A poll consumes no grant."),
    grantFacts: () => assert.fail("A poll reads no grant facts."),
  };
}

function pollService(t: TestContext, store: Store) {
  const github = new GitHubPlatform({ baseUrl: CLOSED_LOCAL_PORT });
  const answers: { next: () => Promise<EventsAnswer> } = {
    next: async () => modified(ETAG_FIRST, []),
  };
  const listEvents = t.mock.method(github, "listEvents", () => answers.next());
  const intake = new IntakeService({
    store,
    logger: pino({ enabled: false }),
    health: new HealthRegistry(),
    identity: identity(INTAKE_SERVICE_NAME),
    ...unusedActionDependencies(),
    custody: pollCustody(),
    github,
    projects: {
      get: async () => ({
        type: OperationResultType.Completed,
        status: HttpStatus.OK,
        data: {
          id: PROJECT_ID,
          name: "inbounds",
          binding_set_version: 1,
          created_at: 1,
          workspace_directory: "/workspace",
        },
      }),
    },
    pollIntervalMs: INTERVAL_MS,
  });
  const registry = new OperationRegistry();
  intake.declare(registry);
  const caller: CallerContext = {
    identity: testHumanIdentity("ulrich", "Ulrich", ulid()),
    context: background,
    requestId: createIdentity("request"),
    commit: (write) => store.transaction(write),
  };
  const create = async (body: InboundCreate) => {
    const operation = intakeOperations["inbound.create"];
    return operation.output.parse(
      await registry
        .get(operation.id)
        .handler(
          operation.input.parse({ params: {}, query: {}, body }),
          caller,
        ),
    );
  };
  const remove = async (inboundId: string) => {
    const operation = intakeOperations["inbound.delete"];
    await registry.get(operation.id).handler(
      operation.input.parse({
        params: { inbound_id: inboundId },
        query: {},
        body: null,
      }),
      caller,
    );
  };
  const interval = async () => {
    t.mock.timers.tick(INTERVAL_MS);
    await settle();
  };
  const queries = () => listEvents.mock.calls.map((call) => call.arguments[1]);
  const signals = () =>
    listEvents.mock.calls.map((call) => call.arguments[0]?.signal);
  return {
    intake,
    answers,
    listEvents,
    create,
    remove,
    interval,
    queries,
    signals,
  };
}

function pollStore(t: TestContext): Store {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  return store;
}

async function shutDown(
  intake: IntakeService,
  running: Promise<Error | null>,
): Promise<void> {
  assert.equal(await intake.quiesce(), null);
  await intake.drain();
  assert.equal(await intake.stop(), null);
  assert.equal(await running, null);
}

test("run starts one poll loop per poll inbound and none for a webhook", async (t) => {
  const store = pollStore(t);
  insertNaming(store, InboundKind.Poll, CREDENTIAL);
  insertNaming(store, InboundKind.Poll, CREDENTIAL);
  insertNaming(store, InboundKind.Webhook, null);
  const s = pollService(t, store);
  const running = s.intake.run();
  await settle();
  assert.equal(s.listEvents.mock.callCount(), NO_CALLS);
  await s.interval();
  assert.equal(s.listEvents.mock.callCount(), TWO_CALLS);
  await shutDown(s.intake, running);
});

test("an inbound delete stops its poll loop", async (t) => {
  const store = pollStore(t);
  const id = insertNaming(store, InboundKind.Poll, CREDENTIAL);
  const s = pollService(t, store);
  const stop = t.mock.method(s.intake.pollLoops, "stop");
  const running = s.intake.run();
  await settle();
  await s.remove(id);
  assert.deepEqual(
    stop.mock.calls.map((call) => call.arguments),
    [[id]],
  );
  await s.interval();
  assert.equal(s.listEvents.mock.callCount(), NO_CALLS);
  await shutDown(s.intake, running);
});

test("a restart starts the poll loops again from the stored checkpoint", async (t) => {
  const store = pollStore(t);
  insertNaming(store, InboundKind.Poll, CREDENTIAL, {
    etag: ETAG_STORED,
    newest_event_id: "100",
  });
  const first = pollService(t, store);
  first.answers.next = async () => modified(ETAG_FIRST, [ev("101")]);
  const firstRun = first.intake.run();
  await settle();
  await first.interval();
  assert.deepEqual(first.queries(), [
    { owner: "acme", repo: "app", etag: ETAG_STORED },
  ]);
  await shutDown(first.intake, firstRun);
  const second = pollService(t, store);
  const secondRun = second.intake.run();
  await settle();
  await second.interval();
  assert.deepEqual(second.queries(), [
    { owner: "acme", repo: "app", etag: ETAG_FIRST },
  ]);
  await shutDown(second.intake, secondRun);
});
