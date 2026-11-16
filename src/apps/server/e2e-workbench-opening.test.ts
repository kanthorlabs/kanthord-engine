import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getAgentDeclaration } from "../../agent/catalog.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import { isString } from "../../kernel/values.ts";
import {
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_OPENING_TEXT,
} from "../../workbench/contract.ts";
import {
  AGENT,
  completed,
  DEFAULT,
  OFF,
  sendMessage,
  SONNET,
  untilIdle,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-opening");
const { workbenchFixture } = workbenchHarness(identity);
const ANSWER = "Two objectives are open.";
const QUESTION = "How many objectives are open?";
const FACTORY_FAILURE = "The runtime factory failed.";
const OPEN_FAILURE = "The open failed.";
const MESSAGE_ENTRY = "message";
const MODEL_CHANGE = "model_change";
const THINKING_CHANGE = "thinking_level_change";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const NO_ITEMS = 0;
const SINGLE = 1;
const TEST_TIMEOUT_MS = 60000;
const CONFIGURATION = {
  agent_provider: DEFAULT,
  model_identifier: SONNET,
  reasoning_effort: OFF,
};
const GREETING = `Hi, I am ${getAgentDeclaration(AGENT)?.display_name} on ${SONNET}. What do you need?`;

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Entry = Record<string, unknown>;

function textOf(content: unknown): string {
  return isString(content)
    ? content
    : (content as { text?: string }[])
        .map((block) => block.text ?? "")
        .join("");
}

function messagesOf(entries: readonly Entry[]) {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .map(({ role, content }) => ({ role, text: textOf(content) }));
}

function sessionFiles(state: string): string[] {
  const directory = join(state, "pi", "sessions", "workbench", AGENT);
  return existsSync(directory)
    ? readdirSync(directory).map((name) => join(directory, name))
    : [];
}

function create(fixture: Fixture) {
  return fixture.workbench["session.create"](
    {
      params: {},
      query: {},
      body: { agent_name: AGENT, ...CONFIGURATION },
    },
    fixture.options,
  );
}

async function openedFixture(
  t: TestContext,
  script = [fauxAssistantMessage(ANSWER)],
) {
  const state = temporaryDirectory();
  const fixture = await workbenchFixture(t, script, state);
  return { state, fixture };
}

test(
  "(happy path) create writes the opening pair with no model call and the first run receives it",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await openedFixture(t);
    const session = completed(await create(fixture));
    assert.equal(fixture.provider.calls.length, NO_ITEMS);
    const [file] = sessionFiles(state);
    assert.ok(file);
    const stored = readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Entry);
    const firstMessage = stored.findIndex(
      (entry) => entry.type === MESSAGE_ENTRY,
    );
    const setup = stored.slice(NO_ITEMS, firstMessage);
    assert.ok(
      setup.some((entry) => entry.customType === WORKBENCH_CONFIGURATION_ENTRY),
    );
    assert.ok(setup.some((entry) => entry.type === MODEL_CHANGE));
    assert.ok(setup.some((entry) => entry.type === THINKING_CHANGE));
    assert.deepEqual(messagesOf(stored), [
      { role: USER_ROLE, text: WORKBENCH_OPENING_TEXT },
      { role: ASSISTANT_ROLE, text: GREETING },
    ]);
    assert.deepEqual(messagesOf(session.entries), [
      { role: ASSISTANT_ROLE, text: GREETING },
    ]);
    const viewed = completed(
      await fixture.workbench["session.get"](
        { params: { session_id: session.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    assert.deepEqual(messagesOf(viewed.entries), messagesOf(session.entries));
    completed(await sendMessage(fixture, session.id, QUESTION));
    await untilIdle(fixture, session.id, t.signal);
    const [call] = fixture.provider.calls;
    assert.ok(call);
    assert.deepEqual(
      (call.messages as { role: string; content: unknown }[])
        .filter(({ role }) => role !== SYSTEM_ROLE)
        .map(({ role, content }) => ({ role, text: textOf(content) })),
      [
        { role: USER_ROLE, text: WORKBENCH_OPENING_TEXT },
        { role: ASSISTANT_ROLE, text: GREETING },
        { role: USER_ROLE, text: QUESTION },
      ],
    );
  },
);

test(
  "(security, guard input) Run.request of the first run never holds the opening text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { fixture } = await openedFixture(t);
    const session = completed(await create(fixture));
    type Notified = { run: { request: string } | null };
    const service = fixture.workbenchService as unknown as {
      notify(session: Notified): void;
    };
    const notify = service.notify.bind(service);
    const requests: string[] = [];
    t.mock.method(service, "notify", (notified: Notified) => {
      if (notified.run) requests.push(notified.run.request);
      notify(notified);
    });
    completed(await sendMessage(fixture, session.id, QUESTION));
    await untilIdle(fixture, session.id, t.signal);
    assert.ok(requests.length >= SINGLE);
    assert.deepEqual([...new Set(requests)], [QUESTION]);
  },
);

test(
  "(invariant, rollback) a runtime factory failure leaves no session file and no open session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const state = temporaryDirectory();
    let failing = false;
    const fixture = await workbenchFixture(
      t,
      [],
      state,
      undefined,
      [AGENT],
      async () => {
        if (failing) throw new Error(FACTORY_FAILURE);
      },
    );
    failing = true;
    assert.equal((await create(fixture)).type, OperationResultType.Failure);
    assert.deepEqual(sessionFiles(state), []);
    const service = fixture.workbenchService as unknown as {
      sessions: Map<string, unknown>;
    };
    assert.equal(service.sessions.size, NO_ITEMS);
  },
);

test(
  "(invariant, rollback) an open failure after the opening pair removes the host file and the open session",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await openedFixture(t, []);
    const service = fixture.workbenchService as unknown as {
      sessions: Map<string, unknown>;
      openAgent(): Promise<void>;
    };
    t.mock.method(service, "openAgent", async () => {
      assert.equal(sessionFiles(state).length, SINGLE);
      throw new Error(OPEN_FAILURE);
    });
    assert.equal((await create(fixture)).type, OperationResultType.Failure);
    assert.deepEqual(sessionFiles(state), []);
    assert.equal(service.sessions.size, NO_ITEMS);
  },
);
