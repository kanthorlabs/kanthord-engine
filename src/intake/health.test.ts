import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  InboundOperation,
  type GrantOf,
  type GrantRequest,
  type Material,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { ResourceStatus } from "../kernel/health.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import type {
  GitHubAnswer,
  GitHubCall,
  GitHubCheckpoint,
  GitHubEventsAnswer,
  GitHubEventsQuery,
} from "../repository/github.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundKind,
  InboundPlatform,
  ResultClass,
  type InboundKindValue,
} from "./contract.ts";
import {
  INBOUND_TARGET_KIND,
  InboundCapability,
  inboundInventory,
  type InboundHealthDependencies,
} from "./health.ts";
import { allocateInboundId, insertInbound } from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const RESOURCE = "owner/repo";
const TOKEN = "ghp_health-token";
const ETAG_STORED = '"etag-0"';
const ETAG_ANSWERED = '"etag-1"';
const CHECKPOINT: GitHubCheckpoint = {
  etag: ETAG_STORED,
  newest_event_id: "100",
};
const FINAL_REFUSAL_CODE = "repository.platform.github.final_refusal";
const UNAUTHORIZED_STATUS = 401;
const CHECK_BUDGET_MS = 5000;
const CREATED_AT = 1;
const NO_CALLS = 0;
const SERVICE_IDENTITY = {
  kind: IdentityKind.Service,
  service: INTAKE_SERVICE_NAME,
} as const;

type EventsAnswer = GitHubAnswer<GitHubEventsAnswer>;
type EventsCall = (call: GitHubCall) => Promise<EventsAnswer>;

function fakeCustody() {
  const grants: GrantRequest[] = [];
  const drops: string[] = [];
  const custody: InboundHealthDependencies["custody"] = {
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

function harness(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: INTAKE_SERVICE_NAME, migrations: intakeMigrations },
  ]);
  const { custody, grants, drops } = fakeCustody();
  const calls: { call: GitHubCall; query: GitHubEventsQuery }[] = [];
  const answers: { next: EventsCall } = {
    next: async () => ({
      ok: true,
      value: { notModified: false, etag: ETAG_ANSWERED, events: [] },
    }),
  };
  const dependencies: InboundHealthDependencies = {
    store,
    identity: SERVICE_IDENTITY,
    custody,
    github: {
      listEvents: async (call, query) => {
        calls.push({ call, query });
        return answers.next(call);
      },
    },
  };
  const insert = (kind: InboundKindValue) => {
    const id = allocateInboundId();
    const poll = kind === InboundKind.Poll;
    store.transaction((tx) =>
      insertInbound(tx, id, {
        project_id: PROJECT_ID,
        kind,
        platform: InboundPlatform.GitHub,
        consumer: Consumer.MissionDeliveryAdmit,
        credential: poll ? CREDENTIAL : null,
        configuration: { resource: RESOURCE },
        checkpoint: poll ? CHECKPOINT : null,
        created_at: CREATED_AT,
      }),
    );
    return id;
  };
  const inventory = () =>
    store.transaction((tx) => inboundInventory(dependencies, tx));
  const entryOf = (id: string) => {
    const entry = inventory().find(
      ({ target }) => target === `${INBOUND_TARGET_KIND}:${id}`,
    );
    assert.ok(entry, "The inventory answers the inbound.");
    return entry;
  };
  const stored = () =>
    store.transaction((tx) => ({
      inbounds: tx.database
        .prepare("SELECT * FROM intake_inbound ORDER BY id")
        .all(),
      events: tx.database.prepare("SELECT * FROM intake_inbound_event").all(),
    }));
  return {
    store,
    grants,
    drops,
    calls,
    answers,
    insert,
    inventory,
    entryOf,
    stored,
  };
}

function checkContext(t: TestContext, budgetMs = CHECK_BUDGET_MS) {
  const context = new CancellationContext(background, Date.now() + budgetMs);
  t.after(() => context.cancel());
  return context;
}

test("the inventory answers one entry per inbound and calls no facility and no platform", (t) => {
  const h = harness(t);
  assert.deepEqual(h.inventory(), []);
  const webhook = h.insert(InboundKind.Webhook);
  const poll = h.insert(InboundKind.Poll);
  const entries = h.inventory();
  assert.deepEqual(
    entries.map(({ project_id, name, target, capability }) => ({
      project_id,
      name,
      target,
      capability,
    })),
    [
      {
        project_id: PROJECT_ID,
        name: encodeURIComponent(webhook),
        target: `${INBOUND_TARGET_KIND}:${webhook}`,
        capability: InboundCapability.Webhook,
      },
      {
        project_id: PROJECT_ID,
        name: encodeURIComponent(poll),
        target: `${INBOUND_TARGET_KIND}:${poll}`,
        capability: InboundCapability.PollAcquisition,
      },
    ].sort((left, right) => (left.target < right.target ? -1 : 1)),
  );
  assert.deepEqual(h.grants, []);
  assert.equal(h.calls.length, NO_CALLS);
});

test("a webhook check answers unknown with no call", async (t) => {
  const h = harness(t);
  const entry = h.entryOf(h.insert(InboundKind.Webhook));
  assert.equal(await entry.check(checkContext(t)), ResourceStatus.Unknown);
  assert.deepEqual(h.grants, []);
  assert.equal(h.calls.length, NO_CALLS);
});

test("a poll check releases one poll grant, sends the stored ETag and answers healthy for a 200", async (t) => {
  const h = harness(t);
  const id = h.insert(InboundKind.Poll);
  const entry = h.entryOf(id);
  const before = h.stored();
  assert.equal(await entry.check(checkContext(t)), ResourceStatus.Healthy);
  assert.deepEqual(h.grants, [
    {
      kind: GrantKind.Inbound,
      identity: SERVICE_IDENTITY,
      inbound: {
        inboundId: id,
        projectId: PROJECT_ID,
        credential: CREDENTIAL,
        platform: InboundPlatform.GitHub,
        resource: RESOURCE,
      },
      operation: InboundOperation.Poll,
    },
  ]);
  assert.deepEqual(
    h.calls.map(({ call, query }) => ({ token: call.token, query })),
    [
      {
        token: TOKEN,
        query: { owner: "owner", repo: "repo", etag: ETAG_STORED },
      },
    ],
  );
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.deepEqual(h.stored(), before);
});

test("a poll check answers healthy for a 304 and changes no inbound", async (t) => {
  const h = harness(t);
  const entry = h.entryOf(h.insert(InboundKind.Poll));
  h.answers.next = async () => ({ ok: true, value: { notModified: true } });
  const before = h.stored();
  assert.equal(await entry.check(checkContext(t)), ResourceStatus.Healthy);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.deepEqual(h.stored(), before);
});

test("a poll check answers unhealthy for a platform result class and observes its code", async (t) => {
  const h = harness(t);
  const entry = h.entryOf(h.insert(InboundKind.Poll));
  h.answers.next = async () => ({
    ok: false,
    class: ResultClass.FinalRefusal,
    code: FINAL_REFUSAL_CODE,
    status: UNAUTHORIZED_STATUS,
    message: "Bad credentials",
  });
  const reasons: string[] = [];
  const before = h.stored();
  assert.equal(
    await entry.check(checkContext(t), (reason) => reasons.push(reason)),
    ResourceStatus.Unhealthy,
  );
  assert.deepEqual(reasons, [FINAL_REFUSAL_CODE]);
  assert.deepEqual(h.drops, [CREDENTIAL]);
  assert.deepEqual(h.stored(), before);
});
