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
import { environment, kanthord } from "./cli-support.ts";
import { fakeGitHub, gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const TIMEOUT = 180000;
const POLL_INTERVAL_MS = 50;
const PENDING_EVENT_LIMIT = 3;
const WAIT_LIMIT_MS = 5000;
const QUIET_INTERVALS = 4;
const ONE_CALL = 1;
const VALIDATION_AND_HELD = 2;
const ANSWERED_CALLS = 2;
const FIRST_BATCH = 2;
const NOT_MODIFIED = 304;
const SERVER_ERROR = 500;
const OWNER = "owner";
const REPO = "repo";
const RESOURCE = `${OWNER}/${REPO}`;
const CREDENTIAL = "github";
const GITHUB_KEY = "e2e_poll_github_key";
const PUSH_EVENT = "PushEvent";
const PULL_REQUEST_EVENT = "PullRequestEvent";
const EVENTS_PATH = /^\/repos\/owner\/repo\/events(\?|$)/;
const PLATFORM_REFUSED = `${IntakeErrorCode.InboundPlatformRefused}:`;
const EVENTS_PENDING = `${IntakeErrorCode.InboundEventsPending}:`;
type Result = { code: number; stdout: string; stderr: string };
type Checkpoint = { etag: string | null; newest_event_id: string | null };
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

async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + WAIT_LIMIT_MS;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    assert.ok(Date.now() < deadline, "The awaited state did not arrive.");
    await delay(POLL_INTERVAL_MS);
  }
}

test("E07 poll acquisition journey", { timeout: TIMEOUT }, async (t) => {
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    intake: {
      pollIntervalMs: POLL_INTERVAL_MS,
      pendingEventLimit: PENDING_EVENT_LIMIT,
    },
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
  const first = [ev(101, PUSH_EVENT), ev(100, PULL_REQUEST_EVENT)];
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

  let release = () => {};

  await t.test("E07.2 a poll create starts a held loop", async () => {
    const before = eventsCalls().length;
    release = gitHub.holdEvents({ pass: 1 });
    t.after(() => release());
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
    const later = await until(
      () => eventsCalls().slice(before),
      (calls) => calls.length > ONE_CALL,
    );
    assert.equal(later.length, VALIDATION_AND_HELD);
    assert.equal(later[1]?.status, null);
  });

  await t.test("E07.3 a failed request stores nothing", async () => {
    gitHub.failEvents(SERVER_ERROR);
    release();
    await until(eventsCalls, (calls) =>
      calls.some((call) => call.status === SERVER_ERROR),
    );
    assert.equal((await inboundOf()).checkpoint, null);
    assert.deepEqual(await events(), []);
    gitHub.failEvents(null);
  });

  await t.test(
    "E07.4 a cycle stores the batch and its checkpoint",
    async () => {
      const items = await until(events, (list) => list.length === FIRST_BATCH);
      assert.deepEqual(
        items.map((item) => [item.event_id, item.metadata, item.state]),
        [
          ["100", { event: PULL_REQUEST_EVENT }, InboundEventState.Pending],
          ["101", { event: PUSH_EVENT }, InboundEventState.Pending],
        ],
      );
      assert.deepEqual((await inboundOf()).checkpoint, {
        etag: etagOf(first),
        newest_event_id: "101",
      });
    },
  );

  await t.test("E07.5 an unchanged list answers 304", async () => {
    const before = eventsCalls().length;
    const later = await until(
      () => eventsCalls().slice(before),
      (calls) =>
        calls.filter((call) => call.status !== null).length >= ANSWERED_CALLS,
    );
    for (const call of later.filter((item) => item.status !== null)) {
      assert.equal(call.if_none_match, etagOf(first));
      assert.equal(call.status, NOT_MODIFIED);
    }
    assert.equal((await events()).length, FIRST_BATCH);
  });

  await t.test("E07.6 the capacity bound pauses the poll", async () => {
    gitHub.events(OWNER, REPO, [
      ev(103, PUSH_EVENT),
      ev(102, PUSH_EVENT),
      ...first,
    ]);
    const items = await until(
      events,
      (list) => list.length === PENDING_EVENT_LIMIT,
    );
    assert.deepEqual(
      items.map((item) => item.event_id),
      ["100", "101", "102"],
    );
    assert.deepEqual((await inboundOf()).checkpoint, {
      etag: null,
      newest_event_id: "102",
    });
    const count = eventsCalls().length;
    await delay(POLL_INTERVAL_MS * QUIET_INTERVALS);
    assert.equal(eventsCalls().length, count);
  });

  await t.test("E07.7 a pending event blocks the delete", async () => {
    refused(await inbound(["delete", P]), EVENTS_PENDING);
  });
});
