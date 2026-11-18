import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getAgentDeclaration } from "../../agent/catalog.ts";
import { FORK_SUMMARY_PROMPT } from "../../agent/prompt-assets.ts";
import { isString } from "../../kernel/values.ts";
import { isReadOnlyIdentity } from "../../kernel/caller.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { background } from "../../kernel/context.ts";
import { OperationError } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  AccessPolicy,
  hasHttpRoute,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
  testReadOnlyIdentity,
} from "../../kernel/test-identity.ts";
import { temporary, temporaryDirectory } from "../../kernel/test-support.ts";
import {
  AuthorKind,
  MessageDelivery,
  WORKBENCH_GUEST_MESSAGE_MAX_BYTES,
  WORKBENCH_OPENING_TEXT,
  WORKBENCH_QUEUE_LIMIT,
  WORKBENCH_RELAY_ENTRY,
  workbenchOperations,
  WorkbenchRecordKind,
} from "../../workbench/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { toolName } from "../../workbench/index.ts";
import {
  callsOf,
  completed,
  createHost,
  forkOf,
  GUARD_AGENT,
  heldAnswer,
  invitedProjectIds,
  pass,
  sendMessage,
  untilAbort,
  untilIdle,
  userRequestOf,
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
const OPS_GRANTABLE_COUNT = 10;

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

async function invite(
  fixture: Fixture,
  sessionId: string,
  name: string,
  idempotencyKey?: string,
) {
  return completed(
    await fixture.workbench["invite.create"](
      {
        params: { session_id: sessionId },
        query: {},
        body: {
          invitee_name: name,
          project_ids: await invitedProjectIds(fixture),
          granted_operations: [],
        },
      },
      idempotencyKey === undefined
        ? fixture.options
        : { ...fixture.options, idempotencyKey },
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
    owner_name: string;
    granted_operations: { operation_id: string; guard_class: string }[];
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
      const key = createIdempotencyKey();
      created = await invite(first, sessionId, GUEST_NAME, key);
      const replay = await first.workbench["invite.create"](
        {
          params: { session_id: sessionId },
          query: {},
          body: {
            invitee_name: GUEST_NAME,
            project_ids: await invitedProjectIds(first),
            granted_operations: [],
          },
        },
        { ...first.options, idempotencyKey: key },
      );
      assert.equal(
        replay.type,
        OperationResultType.Failure,
        JSON.stringify(replay),
      );
      assert.ok(replay.type === OperationResultType.Failure);
      assert.equal(replay.status, HttpStatus.Conflict);
      assert.ok(!JSON.stringify(replay).includes(created.invite_token));
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
    assert.equal(view.owner_name, identity.name);
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
        waiting_for_approval: null,
        queue: [],
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
      body: JSON.stringify({ text: GUEST_NOTE }),
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
        text: GUEST_NOTE,
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
      reader: testReadOnlyIdentity(identity.accountId, {
        inviteId: created.id,
        projectIds: [],
        guestName: GUEST_NAME,
      }),
      jti: "race",
    });
    let opened: Response | undefined;
    const opening = fixture.workbenchService
      .guestStream(checked, undefined, background)
      .then((response) => {
        opened = response;
        return response;
      });
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
    const feed = fixture.workbenchService["feeds"].get(host.id);
    assert.ok(feed);
    assert.equal(
      [...feed["streams"]].filter((stream) => stream.inviteId === created.id)
        .length,
      NO_ITEMS,
    );
    assert.equal(opened, undefined);
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

const GUEST_MENTION = "@Yumi what is blocked?";
const OWNER_MENTION = "@Yumi owner question";
const SECOND_OWNER_MENTION = "@Yumi second owner question";
const OWNER_AGENT_NAME = "ops@1";
const LIST_PROJECTS = toolName("project.list");
const TOOL_RESULT_ROLE = "toolResult";
const USER_ROLE = "user";
const MESSAGE_ENTRY = "message";
const AUTHOR_KIND = "author";
const QUEUE_CLEAR_KIND = "queue_clear";
const KIND_RUN = "run";
const AGENT_REFUSED = "workbench.guest.agent_refused";
const QUEUE_FULL = "workbench.session.queue_full";
const AGENT_NOT_FOUND = "agent.catalog.not_found";
const BUILTIN_TOOL = "read";
const FOLLOW_STATE_FRAMES = 20;
const SETTLE_TURNS = 20;

interface RunAnswer {
  kind: string;
  agent_name: string;
  queued_message_id: string | null;
}

interface StateFrameData {
  queue: {
    id: string;
    agent_name: string | null;
    display_name: string | null;
    author_name: string;
  }[];
}

function guestSend(fixture: Fixture, token: string, text: string) {
  return asGuest(fixture, token, MESSAGE_PATH, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

async function guestRun(fixture: Fixture, token: string, text: string) {
  const response = await guestSend(fixture, token, text);
  assert.equal(response.status, HttpStatus.Accepted);
  return (await response.json()) as RunAnswer;
}

async function untilProviderCalls(
  fixture: Fixture,
  count: number,
  signal: AbortSignal,
) {
  while (fixture.provider.calls.length < count) {
    signal.throwIfAborted();
    await setImmediate();
  }
}

function userTexts(entries: readonly { type: string; message?: unknown }[]) {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .filter((message) => message.role === USER_ROLE)
    .map((message) =>
      isString(message.content)
        ? message.content
        : (message.content as { text?: string }[])
            .map((block) => block.text ?? "")
            .join(""),
    );
}

function recordsOfKind(
  entries: readonly Record<string, unknown>[],
  kind: string,
): Record<string, unknown>[] {
  return entries.flatMap((entry) => {
    const data = entry.data as Record<string, unknown> | undefined;
    return data?.kind === kind ? [data] : [];
  });
}

function sessionOf(fixture: Fixture, sessionId: string) {
  const session = fixture.workbenchService["sessions"].get(sessionId);
  assert.ok(session);
  return session;
}

async function queuedFixture(
  t: TestContext,
  script: Parameters<typeof conversationFixture>[1],
) {
  const { fixture } = await conversationFixture(t, script);
  const host = await createHost(fixture, OPS);
  const { created, joined } = await guest(fixture, host.id, GUEST_NAME);
  return { fixture, host, created, joined };
}

test(
  "(happy path) a guest mention starts a run whose reads run under the read-only identity of the inviter",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, [
      fauxAssistantMessage(fauxToolCall(LIST_PROJECTS, { query: {} }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(FIRST_ANSWER),
    ]);
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    const [invited] = await invitedProjectIds(fixture);
    const other = completed(
      await fixture.projects.create(
        { params: {}, query: {}, body: { name: "not-invited" } },
        fixture.options,
      ),
    );
    const answer = await guestRun(fixture, joined.token, GUEST_MENTION);
    assert.deepEqual(answer, {
      kind: KIND_RUN,
      agent_name: OWNER_AGENT_NAME,
      queued_message_id: null,
    });
    await untilIdle(fixture, host.id, t.signal);
    const results = JSON.stringify(
      (await ownerEntries(fixture, host.id)).filter(
        (entry) =>
          (entry.message as { role?: string } | undefined)?.role ===
          TOOL_RESULT_ROLE,
      ),
    );
    assert.ok(results.includes(invited!));
    assert.ok(!results.includes(other.id));
  },
);

test(
  "(happy path) a guest mention during a run queues, and the drained run carries the guest origin and the invite scope",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(FIRST_ANSWER);
    const second = heldAnswer(SECOND_ANSWER);
    const { fixture, host, created, joined } = await queuedFixture(t, [
      first.step,
      second.step,
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    const answer = await guestRun(fixture, joined.token, GUEST_MENTION);
    assert.equal(answer.kind, KIND_RUN);
    assert.ok(answer.queued_message_id);
    first.gate.resolve();
    await untilProviderCalls(fixture, PAIR, t.signal);
    const run = sessionOf(fixture, host.id).run;
    assert.ok(run);
    assert.deepEqual(run.origin, { kind: AuthorKind.Guest, name: GUEST_NAME });
    assert.equal(run.inviteId, created.id);
    assert.deepEqual(
      fixture.workbenchService.runScope(run),
      await invitedProjectIds(fixture),
    );
    second.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    completed(await revoke(fixture, created.id));
    assert.deepEqual(fixture.workbenchService.runScope(run), []);
  },
);

test(
  "(security, authorization) a guest answers 401 on session.message, session.abort, session.queue.remove, session.autoMode.set and session.approve",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, joined } = await queuedFixture(t, []);
    for (const key of [
      "session.message",
      "session.abort",
      "session.queue.remove",
      "session.autoMode.set",
      "session.approve",
    ] as const) {
      const operation = workbenchOperations[key];
      const response = await asGuest(
        fixture,
        joined.token,
        operation.path.replace(PATH_PARAMETER, PLACEHOLDER),
        { method: operation.method, body: "{}" },
      );
      assert.equal(response.status, HttpStatus.Unauthorized, key);
      await response.body?.cancel();
    }
  },
);

test(
  "(happy path) a stop drops the guest item, and cleared holds the owner items only",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, [
      untilAbort(FIRST_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    const owner = completed(
      await sendMessage(fixture, host.id, SECOND_OWNER_MENTION),
    );
    const stopped = completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    assert.deepEqual(
      stopped.cleared.map(({ id }) => id),
      [owner.queued_message_id],
    );
    for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
    assert.equal(fixture.provider.calls.length, SINGLE);
    assert.deepEqual(sessionOf(fixture, host.id).queuedMessages, []);
  },
);

test(
  "(security, refused path) a guest @Nobody answers 404 agent.catalog.not_found",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, []);
    const response = await guestSend(fixture, joined.token, "@Nobody hello");
    assert.equal(response.status, HttpStatus.NotFound);
    assert.equal((await errorOf(response)).code, AGENT_NOT_FOUND);
    assert.equal(sessionOf(fixture, host.id).run, null);
  },
);

test(
  "(security, refused path) a guest mention past the queue cap answers 409 workbench.session.queue_full",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, [
      untilAbort(FIRST_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    for (let queued = 0; queued < WORKBENCH_QUEUE_LIMIT; queued++)
      await guestRun(fixture, joined.token, GUEST_MENTION);
    const response = await guestSend(fixture, joined.token, GUEST_MENTION);
    assert.equal(response.status, HttpStatus.Conflict);
    assert.equal((await errorOf(response)).code, QUEUE_FULL);
    assert.equal(
      sessionOf(fixture, host.id).queuedMessages.length,
      WORKBENCH_QUEUE_LIMIT,
    );
  },
);

test(
  "(security, invariant) a guest item whose invite ended before its start is dropped and the next item runs",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(FIRST_ANSWER);
    const { fixture, host, created, joined } = await queuedFixture(t, [
      first.step,
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    completed(await revoke(fixture, created.id));
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    const users = userTexts(await ownerEntries(fixture, host.id));
    assert.ok(users.includes(SECOND_OWNER_MENTION));
    assert.ok(!users.includes(GUEST_MENTION));
    assert.equal(fixture.provider.calls.length, PAIR);
  },
);

test(
  "(security) a guest item then an owner item each run under their own identity",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(FIRST_ANSWER);
    const requesters: boolean[] = [];
    const seen = (answer: string) => async () => {
      const session = sessionOf(fixture, host.id);
      const running = fixture.workbenchService["memberOfRun"](
        session,
        session.run,
      );
      requesters.push(isReadOnlyIdentity(running.requester));
      return fauxAssistantMessage(answer);
    };
    const { fixture, host, joined } = await queuedFixture(t, [
      first.step,
      seen(SECOND_ANSWER),
      seen(THIRD_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    assert.deepEqual(requesters, [true, false]);
  },
);

test(
  "(security) a queue change publishes a guest frame whose queue holds no text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(FIRST_ANSWER);
    const { fixture, host, joined } = await queuedFixture(t, [
      first.step,
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const stream = await openStream(t, fixture, joined.token);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    const queued = await guestRun(fixture, joined.token, GUEST_MENTION);
    let frame: Frame | null = null;
    for (let read = 0; read < FOLLOW_STATE_FRAMES; read++) {
      frame = await stream.next();
      const data = frame?.data as Partial<StateFrameData> | undefined;
      if (frame?.event === STATE_EVENT && data?.queue?.length) break;
    }
    const data = frame?.data as StateFrameData;
    assert.deepEqual(data.queue, [
      {
        id: queued.queued_message_id,
        agent_name: OWNER_AGENT_NAME,
        display_name: "Yumi",
        author_name: GUEST_NAME,
      },
    ]);
    assert.ok(!JSON.stringify(frame).includes(GUEST_MENTION));
    first.gate.resolve();
  },
);

test(
  "(happy path) a stop with two queued owner items appends one queue_clear record with count 2 and cause stop, which the guest view holds and the context omits",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, [
      untilAbort(FIRST_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    const records = recordsOfKind(
      await ownerEntries(fixture, host.id),
      QUEUE_CLEAR_KIND,
    );
    assert.deepEqual(records, [
      { kind: QUEUE_CLEAR_KIND, count: PAIR, cause: "stop" },
    ]);
    const context = sessionOf(fixture, host.id).manager.buildSessionContext();
    assert.ok(!JSON.stringify(context).includes(QUEUE_CLEAR_KIND));
    const view = (await guestEntries(fixture, joined.token)).entries as {
      kind: string;
      count?: number;
      text?: string;
    }[];
    assert.deepEqual(
      view.filter(({ kind }) => kind === QUEUE_CLEAR_KIND),
      [
        {
          ...view.find(({ kind }) => kind === QUEUE_CLEAR_KIND),
          count: PAIR,
          text: "The owner stopped the run. 2 queued messages were cleared.",
        },
      ],
    );
  },
);

test(
  "(happy path) a replace with two queued owner items appends one queue_clear record with count 2 and cause replace",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host } = await queuedFixture(t, [
      untilAbort(FIRST_ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    completed(
      await fixture.workbench["session.message"](
        {
          params: { session_id: host.id },
          query: {},
          body: { text: OWNER_MENTION, delivery: MessageDelivery.Replace },
        },
        fixture.options,
      ),
    );
    await untilIdle(fixture, host.id, t.signal);
    assert.deepEqual(
      recordsOfKind(await ownerEntries(fixture, host.id), QUEUE_CLEAR_KIND),
      [{ kind: QUEUE_CLEAR_KIND, count: PAIR, cause: "replace" }],
    );
  },
);

test(
  "(happy path) an author record precedes the user message of a guest run, and the guest view reads it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, [
      fauxAssistantMessage(FIRST_ANSWER),
    ]);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    await untilIdle(fixture, host.id, t.signal);
    const entries = await ownerEntries(fixture, host.id);
    const at = entries.findIndex(
      (entry) =>
        (entry.data as { kind?: string } | undefined)?.kind === AUTHOR_KIND,
    );
    const asked = entries.findIndex((entry) =>
      userTexts([entry]).includes(GUEST_MENTION),
    );
    assert.ok(at >= NO_ITEMS && at < asked, `${at} ${asked}`);
    assert.deepEqual(entries[at]!.data, {
      kind: AUTHOR_KIND,
      author: { kind: AuthorKind.Guest, name: GUEST_NAME },
    });
    const view = (await guestEntries(fixture, joined.token)).entries as {
      kind: string;
      author?: unknown;
    }[];
    assert.deepEqual(view.find(({ kind }) => kind === AUTHOR_KIND)?.author, {
      kind: AuthorKind.Guest,
      name: GUEST_NAME,
    });
  },
);

test(
  "(security) a guest @SWE answers 409 workbench.guest.agent_refused at send and starts no run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, []);
    const response = await guestSend(fixture, joined.token, "@SWE fix it");
    assert.equal(response.status, HttpStatus.Conflict);
    assert.equal((await errorOf(response)).code, AGENT_REFUSED);
    assert.equal(sessionOf(fixture, host.id).run, null);
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
  },
);

test(
  "(security) a queued guest item whose agent gains a built-in tool before its start is dropped with an error message",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const first = heldAnswer(FIRST_ANSWER);
    const { fixture, host, joined } = await queuedFixture(t, [
      first.step,
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilProviderCalls(fixture, SINGLE, t.signal);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    completed(await sendMessage(fixture, host.id, SECOND_OWNER_MENTION));
    const dependencies = fixture.workbenchService["dependencies"];
    dependencies.declarationOf = (agentName) => {
      const declaration = getAgentDeclaration(agentName)!;
      return agentName === OWNER_AGENT_NAME
        ? {
            ...declaration,
            tools: { ...declaration.tools, builtin: [BUILTIN_TOOL as never] },
          }
        : declaration;
    };
    first.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    const users = userTexts(await ownerEntries(fixture, host.id));
    assert.ok(users.includes(SECOND_OWNER_MENTION));
    assert.ok(!users.includes(GUEST_MENTION));
    assert.ok(sessionOf(fixture, host.id).runError);
  },
);

test(
  "(security) workbench.guest.get lists Yumi and Jeremy as mention names and not SWE or RE",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, joined } = await queuedFixture(t, []);
    const response = await asGuest(fixture, joined.token, GET_PATH);
    const view = (await response.json()) as { mention_names: string[] };
    assert.deepEqual([...view.mention_names].sort(), ["Jeremy", "Yumi"]);
  },
);

const PROJECT_NAME = "invite-scope";
const FORK_RELEASES = 3;
const FORK_TEXT = "Carry on.";
const FORK_SUMMARY = "Goal: carry on.";
const FORK_ANSWER = "Carrying on.";
const FOLLOW_UP_MENTION = "@Yumi what else is blocked?";

function relayContents(entries: readonly Record<string, unknown>[]) {
  return entries
    .filter((entry) => entry.customType === WORKBENCH_RELAY_ENTRY)
    .map((entry) => String(entry.content));
}

test(
  "(happy path) the relay of a guest-started run holds the author line of the author record and the shared projects line with their names, and an owner-started run holds neither",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture, host, joined } = await queuedFixture(t, [
      fauxAssistantMessage(FIRST_ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    await untilIdle(fixture, host.id, t.signal);
    completed(await sendMessage(fixture, host.id, OWNER_MENTION));
    await untilIdle(fixture, host.id, t.signal);
    const [projectId] = await invitedProjectIds(fixture);
    const relays = relayContents(await ownerEntries(fixture, host.id));
    assert.equal(relays.length, SINGLE);
    assert.ok(
      relays[0]!.endsWith(
        `${GUEST_NAME} (guest):\n\nProjects shared in this conversation: ${projectId} (${PROJECT_NAME})`,
      ),
      relays[0]!,
    );
  },
);

test(
  "(happy path) the fork material marks a guest run message and its answer with the guest mark, and marks the in-progress line of a guest-started run",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const held = heldAnswer(SECOND_ANSWER);
    const fixture = await workbenchFixture(
      t,
      [
        fauxAssistantMessage(FIRST_ANSWER),
        held.step,
        fauxAssistantMessage(FORK_SUMMARY),
        pass(),
        fauxAssistantMessage(FORK_ANSWER),
      ],
      undefined,
      undefined,
      [OPS, GUARD_AGENT],
    );
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    await untilIdle(fixture, host.id, t.signal);
    await guestRun(fixture, joined.token, FOLLOW_UP_MENTION);
    await untilProviderCalls(fixture, PAIR, t.signal);
    const forked = completed(await forkOf(fixture, host.id, FORK_TEXT));
    await untilIdle(fixture, forked.session_id, t.signal);
    held.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    const [summarizer] = callsOf(fixture, FORK_SUMMARY_PROMPT);
    const { conversation } = userRequestOf(summarizer!);
    const lines = conversation!.split("\n\n");
    assert.ok(lines.includes(`${GUEST_NAME} (guest): ${GUEST_MENTION}`));
    assert.ok(
      lines.includes(`${GUEST_NAME} (guest): Yumi answered: ${FIRST_ANSWER}`),
    );
    assert.ok(
      lines.includes(
        `In progress in the earlier conversation: ${GUEST_NAME} (guest): ${FOLLOW_UP_MENTION}.`,
      ),
    );
    const forkRecords = recordsOfKind(
      await ownerEntries(fixture, forked.session_id),
      "author",
    );
    assert.equal(forkRecords.length, NO_ITEMS);
  },
);

test(
  "(security) a fork while the source runs a guest-started run releases the summarizer and the guard credential under the owner",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const held = heldAnswer(SECOND_ANSWER);
    const fixture = await workbenchFixture(
      t,
      [
        held.step,
        fauxAssistantMessage(FORK_SUMMARY),
        pass(),
        fauxAssistantMessage(FORK_ANSWER),
      ],
      undefined,
      undefined,
      [OPS, GUARD_AGENT],
    );
    const host = await createHost(fixture, OPS);
    const { joined } = await guest(fixture, host.id, GUEST_NAME);
    await guestRun(fixture, joined.token, GUEST_MENTION);
    await untilProviderCalls(fixture, SINGLE, t.signal);
    const dependencies = fixture.workbenchService["dependencies"];
    const original = dependencies.workbenchCredentials;
    const requesters: (() => unknown)[] = [];
    dependencies.workbenchCredentials = (request) => {
      requesters.push(request.requester);
      return original(request);
    };
    const forked = completed(await forkOf(fixture, host.id, FORK_TEXT));
    await untilIdle(fixture, forked.session_id, t.signal);
    held.gate.resolve();
    await untilIdle(fixture, host.id, t.signal);
    assert.equal(requesters.length, FORK_RELEASES);
    for (const requester of requesters) {
      const released = requester() as { jti: string };
      assert.equal(isReadOnlyIdentity(released as never), false);
      assert.equal(released.jti, identity.jti);
    }
  },
);

test(
  "(happy path) an invite with a grant: invite.list answers the live grant per item and the grantable list, and guest.get answers the live grant",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await conversationFixture(t, []);
    const host = await createHost(fixture, OPS);
    const pause = missionOperations["node.pause"].id;
    const block = missionOperations["node.block"].id;
    const created = completed(
      await fixture.workbench["invite.create"](
        {
          params: { session_id: host.id },
          query: {},
          body: {
            invitee_name: GUEST_NAME,
            project_ids: await invitedProjectIds(fixture),
            granted_operations: [block, pause],
          },
        },
        fixture.options,
      ),
    );
    assert.deepEqual(created.granted_operations, [block, pause]);
    const joined = await joinGuest(fixture, created, GUEST_NAME);
    const expected = [
      { operation_id: block, guard_class: "judged" },
      { operation_id: pause, guard_class: "reversible" },
    ];
    const listed = completed(
      await fixture.workbench["invite.list"](
        { params: { session_id: host.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    assert.deepEqual(listed.items[NO_ITEMS]?.granted_operations, expected);
    assert.equal(listed.grantable.length, OPS_GRANTABLE_COUNT);
    assert.deepEqual(
      expected.map(
        ({ operation_id, guard_class }) =>
          listed.grantable.find((item) => item.operation_id === operation_id)
            ?.guard_class === guard_class,
      ),
      [true, true],
    );
    assert.ok(
      listed.grantable.every(
        ({ description }) => description.length > NO_ITEMS,
      ),
    );
    const view = await guestEntries(fixture, joined.token);
    assert.deepEqual(view.granted_operations, expected);
  },
);
