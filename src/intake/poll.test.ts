import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import type { GitHubCheckpoint, GitHubEvent } from "../repository/github.ts";
import {
  Consumer,
  INTAKE_SERVICE_NAME,
  InboundEventState,
  InboundKind,
  InboundPlatform,
} from "./contract.ts";
import { insertEvent } from "./event-store.ts";
import {
  allocateInboundId,
  deleteInbound,
  insertInbound,
} from "./inbound-store.ts";
import { intakeMigrations } from "./migrations.ts";
import { storeBatch } from "./poll.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const CREDENTIAL = "github-poll";
const RESOURCE = "owner/repo";
const ETAG_STORED = '"etag-0"';
const ETAG_FIRST = '"etag-1"';
const ETAG_SECOND = '"etag-2"';
const SMALL_LIMIT = 2;
const LARGE_LIMIT = 100;

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
