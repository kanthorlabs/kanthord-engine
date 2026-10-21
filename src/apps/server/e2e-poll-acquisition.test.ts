import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  Consumer,
  InboundEventState,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
} from "../../intake/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ActorKind,
  ActorService,
  AssetKind,
  NodeState,
  type Evidence,
} from "../../mission/contract.ts";
import { ActionResultKind } from "../../worker/contract.ts";
import { environment, kanthord, until } from "./cli-support.ts";
import {
  FIRST_INDEX,
  RESOURCE as GATED_REPOSITORY,
  setup,
  type Page,
} from "./delivery-support.ts";
import {
  fakeGitHub,
  gatewayFixture,
  seedUnresolvedRequest,
} from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const TIMEOUT = 180000;
const POLL_INTERVAL_MS = 50;
const VALIDATION_CALLS = 1;
const COMPLETING_CALLS = 1;
const HELD_CALLS = 1;
const ANSWERED_CALLS = 2;
const FIRST_BATCH = 2;
const SECOND_BATCH = 3;
const HIGH_EVENT_ID = 23984532267;
const LOW_EVENT_ID = 17268923404;
const LOWER_EVENT_ID = 17268923405;
const NOT_MODIFIED = 304;
const SERVER_ERROR = 500;
const OWNER = "owner";
const REPO = "repo";
const RESOURCE = `${OWNER}/${REPO}`;
const RESOURCE_IDENTITY = `repository:github:${RESOURCE}`;
const IDLE_INTERVALS = 6;
const SEEDED_NUMBER = 1;
const CREDENTIAL = "github";
const GITHUB_KEY = "e2e_poll_github_key";
const PUSH_EVENT = "PushEvent";
const PULL_REQUEST_EVENT = "PullRequestEvent";
const CLOSED_PULL_REQUEST_EVENT = "pull_request_closed";
const MERGED_COMMIT = "e".repeat(40);
const FIRST_PULL_REQUEST = 1;
const FIRST_ATTEMPT = 1;
const LANDED_EVIDENCE_COUNT = 1;
const DELIVERY_CREDENTIAL = "github";
const EVENTS_PATH = /^\/repos\/owner\/repo\/events(\?|$)/;
const PULLS_PATH = /^\/repos\/owner\/repo\/pulls\?state=closed/;
const GATED_PULLS_PATH = /^\/repos\/owner\/gated\/pulls\?state=closed/;
const PLATFORM_REFUSED = `${IntakeErrorCode.InboundPlatformRefused}:`;
type Result = { code: number; stdout: string; stderr: string };
type Checkpoint = { etag: string | null; pulls_etag: string | null };
type Inbound = { id: string; kind: string; checkpoint: Checkpoint | null };
type Event = {
  event_id: string;
  metadata: Record<string, unknown>;
  state: string;
};

function succeeded<T>(result: Result): T {
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  return JSON.parse(result.stdout) as T;
}

function refused(result: Result, prefix: string): void {
  assert.equal(result.code, ExitCode.Failure, result.stderr);
  assert.ok(result.stderr.startsWith(prefix), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
}

function ev(n: number, type: string) {
  return { id: String(n), type, payload: {} };
}

function etagOf(events: unknown[]): string {
  return `"${createHash("sha256").update(JSON.stringify(events)).digest("hex")}"`;
}

test("E07 poll acquisition journey", { timeout: TIMEOUT }, async (t) => {
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    intake: { pollIntervalMs: POLL_INTERVAL_MS },
  });
  const directory = temporary(t);
  const H = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const file = (name: string, body: unknown) => {
    const path = join(directory, name);
    writePrivate(path, JSON.stringify(body));
    return path;
  };
  succeeded(
    await kanthord(
      [
        "repository",
        "credential",
        "create",
        "--file",
        file("credential.json", {
          name: CREDENTIAL,
          platform: "github",
          metadata: null,
          secret: { key: GITHUB_KEY },
        }),
      ],
      H,
    ),
  );
  const project = succeeded<{ id: string }>(
    await kanthord(["project", "create", "--name", "polls"], H),
  );
  const first = [
    ev(HIGH_EVENT_ID, PUSH_EVENT),
    ev(LOW_EVENT_ID, PULL_REQUEST_EVENT),
  ];
  gitHub.events(OWNER, REPO, first);
  const poll = file("poll.json", {
    project_id: project.id,
    kind: InboundKind.Poll,
    platform: InboundPlatform.GitHub,
    consumer: Consumer.MissionDeliveryAdmit,
    credential: CREDENTIAL,
    configuration: { resource: RESOURCE },
  });
  const inbound = (args: string[]) =>
    kanthord(["intake", "inbound", ...args], H);
  const eventsCalls = () =>
    gitHub.calls.filter((call) => EVENTS_PATH.test(call.path));
  const pullsCalls = () =>
    gitHub.calls.filter((call) => PULLS_PATH.test(call.path));
  let P = "";
  const inboundOf = async () => succeeded<Inbound>(await inbound(["get", P]));
  const events = async () =>
    succeeded<{ items: Event[] }>(
      await kanthord(["intake", "event", "list", "--inbound", P], H),
    ).items.sort((a, b) => a.event_id.localeCompare(b.event_id));

  await t.test("E07.1 a refused validation stores nothing", async () => {
    gitHub.respondNext(HttpStatus.Unauthorized, {
      message: "Bad credentials",
    });
    refused(await inbound(["create", "--file", poll]), PLATFORM_REFUSED);
    const page = succeeded<{ items: Inbound[] }>(
      await inbound(["list", "--project", project.id]),
    );
    assert.deepEqual(page.items, []);
  });

  await t.test(
    "E07.2 a poll create with no unresolved request sends only its validation requests",
    async () => {
      const before = eventsCalls().length;
      const pullsBefore = pullsCalls().length;
      const created = succeeded<Inbound>(
        await inbound(["create", "--file", poll]),
      );
      assert.equal(created.kind, InboundKind.Poll);
      assert.equal(created.checkpoint, null);
      P = created.id;
      const [validation] = eventsCalls().slice(before);
      assert.ok(validation);
      assert.equal(validation.status, HttpStatus.OK);
      assert.equal(validation.if_none_match, null);
      const [pullsValidation] = pullsCalls().slice(pullsBefore);
      assert.ok(pullsValidation);
      assert.equal(pullsValidation.status, HttpStatus.OK);
      assert.equal(pullsValidation.if_none_match, null);
      await delay(IDLE_INTERVALS * POLL_INTERVAL_MS);
      assert.equal(eventsCalls().slice(before).length, VALIDATION_CALLS);
      assert.equal(pullsCalls().slice(pullsBefore).length, VALIDATION_CALLS);
      assert.equal((await inboundOf()).checkpoint, null);
      assert.deepEqual(await events(), []);
    },
  );

  let release = () => {};

  await t.test(
    "E07.3 an unresolved request starts the held requests of the loop",
    async () => {
      const before = eventsCalls().length;
      release = gitHub.holdEvents({ pass: 0 });
      t.after(() => release());
      seedUnresolvedRequest(fixture.store, {
        project_id: project.id,
        resource_identity: RESOURCE_IDENTITY,
        number: SEEDED_NUMBER,
      });
      const later = await until(
        () => eventsCalls().slice(before),
        (calls) => calls.length >= HELD_CALLS,
        t.signal,
      );
      assert.equal(later.length, HELD_CALLS);
      assert.equal(later[0]?.status, null);
    },
  );

  await t.test(
    "E07.4 a failed events read stores nothing, and the closed pull request read still runs",
    async () => {
      gitHub.failEvents(SERVER_ERROR);
      release();
      await until(
        eventsCalls,
        (calls) => calls.some((call) => call.status === SERVER_ERROR),
        t.signal,
      );
      const stored = await until(
        async () => (await inboundOf()).checkpoint,
        (checkpoint) => checkpoint !== null,
        t.signal,
      );
      assert.deepEqual(stored, { etag: null, pulls_etag: etagOf([]) });
      assert.deepEqual(await events(), []);
      gitHub.failEvents(null);
    },
  );

  await t.test(
    "E07.5 a cycle stores the batch and its checkpoint, and the handoff settles each event",
    async () => {
      const items = await until(
        events,
        (list) =>
          list.length === FIRST_BATCH &&
          list.every((item) => item.state === InboundEventState.Succeeded),
        t.signal,
      );
      assert.deepEqual(
        items.map((item) => [item.event_id, item.metadata, item.state]),
        [
          [
            String(LOW_EVENT_ID),
            { event: PULL_REQUEST_EVENT },
            InboundEventState.Succeeded,
          ],
          [
            String(HIGH_EVENT_ID),
            { event: PUSH_EVENT },
            InboundEventState.Succeeded,
          ],
        ],
      );
      assert.deepEqual((await inboundOf()).checkpoint, {
        etag: etagOf(first),
        pulls_etag: etagOf([]),
      });
    },
  );

  await t.test("E07.6 an unchanged list answers 304", async () => {
    const before = eventsCalls().length;
    const pullsBefore = pullsCalls().length;
    const later = await until(
      () => eventsCalls().slice(before),
      (calls) =>
        calls.filter((call) => call.status !== null).length >= ANSWERED_CALLS,
      t.signal,
    );
    for (const call of later.filter((item) => item.status !== null)) {
      assert.equal(call.if_none_match, etagOf(first));
      assert.equal(call.status, NOT_MODIFIED);
    }
    assert.equal((await events()).length, FIRST_BATCH);
    const pulls = await until(
      () => pullsCalls().slice(pullsBefore),
      (calls) =>
        calls.filter((call) => call.status !== null).length >= ANSWERED_CALLS,
      t.signal,
    );
    for (const call of pulls.filter((item) => item.status !== null)) {
      assert.equal(call.if_none_match, etagOf([]));
      assert.equal(call.status, NOT_MODIFIED);
    }
  });

  await t.test(
    "E07.7 a new event with an id below an earlier event id is stored",
    async () => {
      const second = [ev(LOWER_EVENT_ID, PULL_REQUEST_EVENT), ...first];
      gitHub.events(OWNER, REPO, second);
      const items = await until(
        events,
        (list) =>
          list.length === SECOND_BATCH &&
          list.every((item) => item.state === InboundEventState.Succeeded),
        t.signal,
      );
      assert.deepEqual(
        items.map((item) => item.event_id),
        [LOW_EVENT_ID, LOWER_EVENT_ID, HIGH_EVENT_ID].map(String),
      );
      assert.deepEqual((await inboundOf()).checkpoint, {
        etag: etagOf(second),
        pulls_etag: etagOf([]),
      });
    },
  );
});

test(
  "E07.8 the closed pull request list detects a merge that the events never list",
  { timeout: TIMEOUT },
  async (t) => {
    const h = await setup(t, { pollIntervalMs: POLL_INTERVAL_MS });
    const I = await h.create("examine-1.md");
    const P = await h.implement("implement-p.md", I);
    const action = await h.actionRequest(P.x2);
    assert.equal(action.items[FIRST_INDEX]?.kind, ActionResultKind.Submitted);
    await h.release(P.x2.execution_id);
    assert.equal((await h.node(P.nodeId)).state, NodeState.ExternalRequested);
    h.gitHub.merge(FIRST_PULL_REQUEST, MERGED_COMMIT);
    const gatedPullsCalls = () =>
      h.gitHub.calls.filter((call) => GATED_PULLS_PATH.test(call.path));
    const pullsBefore = gatedPullsCalls().length;
    const poll = await h.write<Inbound>(["intake", "inbound", "create"], {
      project_id: h.projectId,
      kind: InboundKind.Poll,
      platform: InboundPlatform.GitHub,
      consumer: Consumer.MissionDeliveryAdmit,
      credential: DELIVERY_CREDENTIAL,
      configuration: { resource: GATED_REPOSITORY },
    });
    await until(
      async () => (await h.node(P.nodeId)).state,
      (state) => state === NodeState.Completed,
      t.signal,
    );
    const answered = gatedPullsCalls()
      .slice(pullsBefore + VALIDATION_CALLS)
      .filter((call) => call.status === HttpStatus.OK);
    assert.equal(answered.length, COMPLETING_CALLS);
    const listed = await h.read<{ items: (Event & { id: string })[] }>([
      "intake",
      "event",
      "list",
      "--inbound",
      poll.id,
    ]);
    const closedEvents = listed.items.filter(
      (item) => item.metadata.event === CLOSED_PULL_REQUEST_EVENT,
    );
    assert.equal(closedEvents.length, LANDED_EVIDENCE_COUNT);
    assert.ok(
      listed.items.every(
        (item) => item.metadata.event === CLOSED_PULL_REQUEST_EVENT,
      ),
    );
    const evidence = await h.read<Page<Evidence>>([
      "mission",
      "evidence",
      "list",
      P.nodeId,
      "--attempt",
      String(FIRST_ATTEMPT),
    ]);
    const landed = evidence.items.filter(
      (item) => item.provenance.kind === ActorKind.Service,
    );
    assert.equal(landed.length, LANDED_EVIDENCE_COUNT);
    assert.deepEqual(landed[FIRST_INDEX]!.provenance, {
      kind: ActorKind.Service,
      service: ActorService.Mission,
      inbound_event_id: closedEvents[FIRST_INDEX]!.id,
    });
    const asset = landed[FIRST_INDEX]!.assets[FIRST_INDEX]!;
    assert.ok(asset.kind === AssetKind.Repository);
    assert.equal(asset.address.commit, MERGED_COMMIT);
  },
);
