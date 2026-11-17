import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { background } from "../../kernel/context.ts";
import { OperationError } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { AccessPolicy, hasHttpRoute } from "../../kernel/operation.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
} from "../../kernel/test-identity.ts";
import { temporary, temporaryDirectory } from "../../kernel/test-support.ts";
import {
  AuthorKind,
  WORKBENCH_GUEST_MESSAGE_MAX_BYTES,
  WORKBENCH_OPENING_TEXT,
  WorkbenchRecordKind,
} from "../../workbench/contract.ts";
import {
  completed,
  createHost,
  sendMessage,
  untilIdle,
  type WorkbenchFixture,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-guest");
const { conversationFixture, workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const GUEST_NAME = "Mira";
const OTHER_GUEST_NAME = "Noor";
const GUEST_NOTE = "Mira asks which node blocks the release.";
const MENTION_RE = "@RE what is blocked?";
const MENTION_HOST = "@Yumi what is blocked?";
const FIRST_ANSWER = "Node one is blocked.";
const SECOND_ANSWER = "Node two is blocked.";
const THIRD_ANSWER = "Node three is blocked.";
const GREETING_PREFIX = "Hi, I am ";
const STREAM_PATH = "/api/workbench/guest/session/stream";
const GET_PATH = "/api/workbench/guest/session";
const MESSAGE_PATH = "/api/workbench/guest/session/message";
const EVENT_STREAM = "text/event-stream";
const INVITE_ENDED = "gateway.jwt.invite_ended";
const VALIDATION_FAILED = "gateway.request.validation_failed";
const ENTRIES_EVENT = "entries";
const STATE_EVENT = "state";
const ASSISTANT_KIND = "assistant";
const FRAME_END = "\n\n";
const FRAME_PATTERN = /^event: (\w+)\ndata: (.*)$/s;
const PATH_PARAMETER = /:[^/]+/g;
const PLACEHOLDER = "x";
const MASTER_KEY_BYTES = 32;
const TEST_TIMEOUT_MS = 60000;
const MIN_HUMAN_OPERATIONS = 100;
const NO_ITEMS = 0;
const SINGLE = 1;
const PAIR = 2;

type Fixture = WorkbenchFixture;

interface Frame {
  event: string;
  data: unknown;
}

interface GuestEntryView {
  id: string;
  session_id: string;
  kind: string;
}

interface Joined {
  token: string;
  guestId: string;
  inviteId: string;
}

async function invite(fixture: Fixture, sessionId: string, name: string) {
  return completed(
    await fixture.workbench["invite.create"](
      {
        params: { session_id: sessionId },
        query: {},
        body: { invitee_name: name },
      },
      fixture.options,
    ),
  );
}

async function joinGuest(
  fixture: Fixture,
  created: { invite_token: string; id: string },
  name: string,
): Promise<Joined> {
  const joined = completed(
    await fixture.workbench["invite.join"](
      {
        params: {},
        query: {},
        body: { invite_token: created.invite_token, name },
      },
      fixture.options,
    ),
  );
  return {
    token: joined.guest_token,
    guestId: joined.guest_id,
    inviteId: created.id,
  };
}

async function guest(fixture: Fixture, sessionId: string, name: string) {
  const created = await invite(fixture, sessionId, name);
  return { created, joined: await joinGuest(fixture, created, name) };
}

function revoke(fixture: Fixture, inviteId: string) {
  return fixture.workbench["invite.revoke"](
    { params: { invite_id: inviteId }, query: {}, body: null },
    fixture.options,
  );
}

function asGuest(
  fixture: Fixture,
  token: string,
  path: string,
  init: RequestInit = {},
) {
  return fixture.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined
        ? {}
        : {
            "content-type": "application/json",
            "Idempotency-Key": createIdempotencyKey(),
          }),
    },
  });
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { code: string; details: unknown };
  };
  return body.error;
}

function parsedFrame(block: string): Frame {
  const match = FRAME_PATTERN.exec(block);
  assert.ok(match, block);
  return { event: match[1]!, data: JSON.parse(match[2]!) };
}

async function openStream(
  t: TestContext,
  fixture: Fixture,
  token: string,
  after?: string,
) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const query =
    after === undefined ? "" : `?after=${encodeURIComponent(after)}`;
  const response = await fixture.request(`${STREAM_PATH}${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  assert.equal(response.status, HttpStatus.OK);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const next = async (): Promise<Frame | null> => {
    for (;;) {
      const end = buffered.indexOf(FRAME_END);
      if (end >= NO_ITEMS) {
        const block = buffered.slice(NO_ITEMS, end);
        buffered = buffered.slice(end + FRAME_END.length);
        if (block.startsWith(":")) continue;
        return parsedFrame(block);
      }
      const chunk = await reader.read();
      if (chunk.done) return null;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  };
  return { response, next };
}

async function guestEntries(fixture: Fixture, token: string) {
  const response = await asGuest(fixture, token, GET_PATH);
  assert.equal(response.status, HttpStatus.OK);
  return (await response.json()) as {
    session_id: string;
    entries: GuestEntryView[];
    members: { session_id: string; agent_name: string; display_name: string }[];
  };
}

async function ownerEntries(
  fixture: Fixture,
  sessionId: string,
  after?: string,
) {
  return completed(
    await fixture.workbench["session.events"](
      {
        params: { session_id: sessionId },
        query: after === undefined ? {} : { after },
        body: null,
      },
      fixture.options,
    ),
  ).entries;
}

function cursorOf(entries: readonly { session_id: string; id: string }[]) {
  const last = new Map<string, string>();
  for (const entry of entries) last.set(entry.session_id, entry.id);
  return [...last].map(([member, entryId]) => `${member}:${entryId}`).join(",");
}

test(
  "(happy path) an invite on a conversation with the greeting lists its name and, after a restart, the guest reads the greeting and no opening text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporaryDirectory();
    const persistence = {
      path: join(temporary(t), "operational.db"),
      masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      resumed: false,
    };
    let sessionId = "";
    let created: Awaited<ReturnType<typeof invite>> | undefined;
    await t.test("invite and stop", async (step) => {
      const first = await workbenchFixture(
        step,
        [],
        state,
        undefined,
        [OPS],
        undefined,
        persistence,
      );
      sessionId = (await createHost(first, OPS)).id;
      created = await invite(first, sessionId, GUEST_NAME);
      const listed = completed(
        await first.workbench["invite.list"](
          { params: { session_id: sessionId }, query: {}, body: null },
          first.options,
        ),
      );
      assert.deepEqual(
        listed.items.map(({ invitee_name }) => invitee_name),
        [GUEST_NAME],
      );
      assert.equal(
        (await first.workbenchService.stop()) ?? undefined,
        undefined,
      );
    });
    const second = await workbenchFixture(
      t,
      [],
      state,
      undefined,
      [OPS],
      undefined,
      { ...persistence, resumed: true },
    );
    assert.ok(created);
    const joined = await joinGuest(second, created, GUEST_NAME);
    const view = await guestEntries(second, joined.token);
    assert.equal(view.session_id, sessionId);
    const text = JSON.stringify(view.entries);
    assert.ok(text.includes(GREETING_PREFIX));
    assert.ok(!text.includes(WORKBENCH_OPENING_TEXT));
  },
);

test(
  "(happy path) the guest stream answers text/event-stream with the entries after the cursor and the current state",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    const stream = await openStream(t, fixture, joined.token);
    assert.equal(stream.response.headers.get("content-type"), EVENT_STREAM);
    const entries = await stream.next();
    assert.equal(entries?.event, ENTRIES_EVENT);
    assert.ok(JSON.stringify(entries?.data).includes(GREETING_PREFIX));
    const current = await stream.next();
    assert.deepEqual(current, {
      event: STATE_EVENT,
      data: {
        run_active: false,
        display_name: null,
        auto_mode: true,
        streaming: null,
      },
    });
  },
);

test(
  "(happy path) a guest message appends a note of the guest and answers kind note",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    const response = await asGuest(fixture, joined.token, MESSAGE_PATH, {
      method: "POST",
      body: JSON.stringify({ text: MENTION_RE }),
    });
    assert.equal(response.status, HttpStatus.Accepted);
    assert.deepEqual(await response.json(), { kind: "note" });
    const notes = (await ownerEntries(fixture, host.id)).flatMap((entry) => {
      const data = entry.data as { kind?: string } | undefined;
      return data?.kind === WorkbenchRecordKind.Note ? [data] : [];
    });
    assert.deepEqual(notes, [
      {
        kind: WorkbenchRecordKind.Note,
        text: MENTION_RE,
        author: { kind: AuthorKind.Guest, name: GUEST_NAME },
      },
    ]);
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
  },
);

test(
  "(happy path) a revoke closes every stream of that invite and no other stream",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const revoked = await guest(fixture, host.id, GUEST_NAME);
    const kept = await guest(fixture, host.id, OTHER_GUEST_NAME);
    const streams = [
      await openStream(t, fixture, revoked.joined.token),
      await openStream(t, fixture, revoked.joined.token),
    ];
    const other = await openStream(t, fixture, kept.joined.token);
    for (const stream of [...streams, other]) {
      await stream.next();
      await stream.next();
    }
    completed(await revoke(fixture, revoked.created.id));
    for (const stream of streams) assert.equal(await stream.next(), null);
    await fixture.workbenchService.note(
      host.id,
      { kind: AuthorKind.Owner, name: "Ulrich" },
      GUEST_NOTE,
    );
    const frame = await other.next();
    assert.equal(frame?.event, ENTRIES_EVENT);
    assert.ok(JSON.stringify(frame?.data).includes(GUEST_NOTE));
  },
);

test(
  "(security, authorization) a guest token answers 401 on every human operation, the action report, the fork and the evidence download included",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    const human = fixture.gateway.registry
      .all()
      .map(({ operation }) => operation)
      .filter(
        (operation) =>
          operation.access === AccessPolicy.Human && hasHttpRoute(operation),
      );
    const ids = human.map(({ id }) => id);
    for (const required of [
      "workbench.session.action.report",
      "workbench.session.fork",
      "mission.evidence.asset.content.download",
    ])
      assert.ok(ids.includes(required), required);
    assert.ok(human.length >= MIN_HUMAN_OPERATIONS, String(human.length));
    for (const operation of human) {
      const response = await asGuest(
        fixture,
        joined.token,
        operation.path.replace(PATH_PARAMETER, PLACEHOLDER),
        {
          method: operation.method,
          ...(operation.body ? { body: "{}" } : {}),
        },
      );
      assert.equal(response.status, HttpStatus.Unauthorized, operation.id);
      await response.body?.cancel();
    }
  },
);

test(
  "(security, authentication) the guest stream answers 401 to a human token",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const response = await asGuest(fixture, fixture.token, STREAM_PATH);
    assert.equal(response.status, HttpStatus.Unauthorized);
  },
);

test(
  "(security, authentication) the guest stream answers 401 to a revoked invite",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { created, joined } = await guest(fixture, host.id, GUEST_NAME);
    completed(await revoke(fixture, created.id));
    const response = await asGuest(fixture, joined.token, STREAM_PATH);
    assert.equal(response.status, HttpStatus.Unauthorized);
    assert.equal((await errorOf(response)).code, INVITE_ENDED);
  },
);

test(
  "(security, argument guard) a guest message text of 16385 bytes answers 400 at body.text and appends no note",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    const response = await asGuest(fixture, joined.token, MESSAGE_PATH, {
      method: "POST",
      body: JSON.stringify({
        text: PLACEHOLDER.repeat(WORKBENCH_GUEST_MESSAGE_MAX_BYTES + SINGLE),
      }),
    });
    assert.equal(response.status, HttpStatus.BadRequest);
    const error = await errorOf(response);
    assert.equal(error.code, VALIDATION_FAILED);
    assert.deepEqual(
      (error.details as { path: string[] }[]).map(({ path }) => path),
      [["body", "text"]],
    );
    const notes = (await ownerEntries(fixture, host.id)).filter(
      (entry) =>
        (entry.data as { kind?: string } | undefined)?.kind ===
        WorkbenchRecordKind.Note,
    );
    assert.equal(notes.length, NO_ITEMS);
  },
);

test(
  "(invariant, two-writer race) a revoke between the Gateway check and the open answers 401 and registers no stream",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const { created, joined } = await guest(fixture, host.id, GUEST_NAME);
    const checked = testGuestIdentity({
      guestId: joined.guestId,
      name: GUEST_NAME,
      inviteId: created.id,
      sessionId: host.id,
      invitedBy: identity.accountId,
      jti: "race",
    });
    const opening = fixture.workbenchService.guestStream(
      checked,
      undefined,
      background,
    );
    fixture.workbenchService.inviteRevoke(created.id);
    await assert.rejects(opening, (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.Unauthorized);
      assert.equal(error.code, INVITE_ENDED);
      return true;
    });
    await fixture.workbenchService.note(
      host.id,
      { kind: AuthorKind.Owner, name: "Ulrich" },
      GUEST_NOTE,
    );
  },
);

test(
  "(invariant, data loss) a reconnect with the merged cursor gets every later entry of each member once and the current state",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(FIRST_ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
      fauxAssistantMessage(THIRD_ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    completed(await sendMessage(fixture, host.id, MENTION_RE));
    await untilIdle(fixture, host.id, t.signal);
    const cursor = cursorOf(await ownerEntries(fixture, host.id));
    assert.equal(cursor.split(",").length, PAIR);
    completed(await sendMessage(fixture, host.id, MENTION_HOST));
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, MENTION_RE));
    await untilIdle(fixture, host.id, t.signal);
    const later = await ownerEntries(fixture, host.id, cursor);
    const stream = await openStream(t, fixture, joined.token, cursor);
    const entries = await stream.next();
    assert.equal(entries?.event, ENTRIES_EVENT);
    const shown = entries?.data as GuestEntryView[];
    const ids = shown.map(({ id }) => id);
    assert.equal(new Set(ids).size, ids.length);
    const laterIds = new Set(later.map(({ id }) => id));
    for (const id of ids) assert.ok(laterIds.has(id), id);
    const assistants = shown.filter(({ kind }) => kind === ASSISTANT_KIND);
    assert.equal(
      new Set(assistants.map(({ session_id }) => session_id)).size,
      PAIR,
    );
    assert.equal(assistants.length, PAIR);
    assert.equal((await stream.next())?.event, STATE_EVENT);
  },
);
