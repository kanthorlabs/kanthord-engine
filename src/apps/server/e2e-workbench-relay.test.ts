import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { PromptTemplate } from "../../agent/contract.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../../agent/prompt-templates.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { temporaryDirectory } from "../../kernel/test-support.ts";
import { isString } from "../../kernel/values.ts";
import {
  WORKBENCH_OPENING_TEXT,
  WORKBENCH_RECORD_ENTRY,
  WORKBENCH_RELAY_ENTRY,
  WorkbenchRecordKind,
} from "../../workbench/contract.ts";
import {
  AGENT,
  completed,
  createHost,
  sendMessage,
  toolCall,
  untilIdle,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-relay");
const { workbenchFixture } = workbenchHarness(identity);
const OPS = "ops@1";
const REVIEW_AGENT = "re@1";
const MARKER_FILE = "marker.txt";
const MARKER_TEXT = "tool result marker";
const MENTION_REQUEST = "@RE look at the marker.";
const HOST_REQUEST = "@Yumi what did RE say?";
const REVIEW_ANSWER = "The marker file is present.";
const HOST_ANSWER = "RE found the marker file.";
const VARIANT_NAME = "Software Architecture";
const RENAMED_VARIANT_NAME = "Design Review";
const VARIANT_INSTRUCTION = "Review the design before any code.";
const VARIANT_REQUEST = `@${VARIANT_NAME} review the design`;
const VARIANT_ANSWER = "The design holds.";
const VARIANT_HOST_REQUEST = "@Yumi what did the reviewer say?";
const RELAY_HEAD = renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Relay, {});
const CUSTOM_MESSAGE_ENTRY = "custom_message";
const SYSTEM_ROLE = "system";
const RUN_STEPS = 3;
const SINGLE = 1;
const TEST_TIMEOUT_MS = 60000;

function textOf(content: unknown): string {
  return isString(content)
    ? content
    : (content as { text?: string }[])
        .map((block) => block.text ?? "")
        .join("");
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - SINGLE;
}

function hostEntries(state: string) {
  const directory = join(state, "pi", "sessions", "workbench", OPS);
  const [file] = readdirSync(directory);
  return readFileSync(join(directory, file!), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function conversation(t: TestContext) {
  const state = temporaryDirectory();
  const workspace = join(state, "workbench", REVIEW_AGENT);
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, MARKER_FILE), MARKER_TEXT);
  const fixture = await workbenchFixture(
    t,
    [
      toolCall("read", { path: MARKER_FILE }),
      fauxAssistantMessage(REVIEW_ANSWER),
      fauxAssistantMessage(HOST_ANSWER),
    ],
    state,
    undefined,
    [OPS, REVIEW_AGENT],
  );
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
  const host = await createHost(fixture, OPS);
  completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
  await untilIdle(fixture, host.id, t.signal);
  completed(await sendMessage(fixture, host.id, HOST_REQUEST));
  await untilIdle(fixture, host.id, t.signal);
  return { state, fixture, requests };
}

function relaysOf(messages: unknown) {
  return (messages as { role: string; content: unknown }[])
    .filter(({ role }) => role !== SYSTEM_ROLE)
    .map(({ content }) => textOf(content))
    .filter((text) => text.startsWith(RELAY_HEAD));
}

test(
  "(happy path) the next host run receives one relay with the human message and the RE answer",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { state, fixture } = await conversation(t);
    const calls = fixture.provider.calls;
    assert.equal(calls.length, RUN_STEPS);
    assert.ok(JSON.stringify(calls[SINGLE]!.messages).includes(MARKER_TEXT));
    assert.deepEqual(relaysOf(calls[0]!.messages), []);
    const relays = relaysOf(calls.at(-SINGLE)!.messages);
    assert.equal(relays.length, SINGLE);
    const [relay] = relays;
    assert.equal(
      occurrences(relay!, `Ulrich to @RE: ${MENTION_REQUEST}`),
      SINGLE,
    );
    assert.equal(occurrences(relay!, `RE: ${REVIEW_ANSWER}`), SINGLE);
    assert.ok(!relay!.includes(MARKER_TEXT));
    assert.ok(!relay!.includes(WORKBENCH_OPENING_TEXT));
    assert.ok(!relay!.includes(HOST_REQUEST));
    const stored = hostEntries(state).filter(
      (entry) => entry.type === CUSTOM_MESSAGE_ENTRY,
    );
    assert.equal(stored.length, SINGLE);
    assert.equal(stored[0]!.customType, WORKBENCH_RELAY_ENTRY);
    assert.equal(stored[0]!.display, false);
  },
);

test(
  "(security, guard input) Run.request never holds relay text",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const { requests } = await conversation(t);
    assert.ok(requests.length >= SINGLE);
    assert.deepEqual(
      [...new Set(requests)].sort(),
      [HOST_REQUEST, MENTION_REQUEST].sort(),
    );
    for (const request of requests) assert.ok(!request.includes(RELAY_HEAD));
  },
);

const NOTICE_NODE_ONE = "node_01M78TVZCNWCDNTBPNNYJT3EDX";
const NOTICE_NODE_TWO = "node_01M78TVZCNWCDNTBPNNYJT3EDY";
const NOTICE_NODE_THREE = "node_01M78TVZCNWCDNTBPNNYJT3EDZ";
const NOTICE_PROJECT_ONE = "project_01M78TVZCNWCDNTBPNNYJT3EDX";
const NOTICE_PROJECT_TWO = "project_01M78TVZCNWCDNTBPNNYJT3EDY";
const NOTICE_ENDED_AT = 1_700_000_000_000;
const SECOND_REVIEW_REQUEST = "@RE what changed?";
const SECOND_REVIEW_ANSWER = "Two nodes ended.";

function noticeNode(nodeId: string, state: string) {
  return {
    node_id: nodeId,
    name: `name of ${nodeId}`,
    state,
    ended_at: NOTICE_ENDED_AT,
  };
}

test(
  "(happy path) the relay of the next run holds the notice line of each project block and no line for a watch record",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await workbenchFixture(
      t,
      [
        fauxAssistantMessage(REVIEW_ANSWER),
        fauxAssistantMessage(SECOND_REVIEW_ANSWER),
      ],
      undefined,
      undefined,
      [OPS, REVIEW_AGENT],
    );
    const host = await createHost(fixture, OPS);
    completed(await sendMessage(fixture, host.id, MENTION_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const { manager } = fixture.workbenchService["sessions"].get(host.id)!;
    const watchId = manager.appendCustomEntry(WORKBENCH_RECORD_ENTRY, {
      kind: WorkbenchRecordKind.Watch,
      node_ids: [NOTICE_NODE_ONE, NOTICE_NODE_TWO, NOTICE_NODE_THREE],
    });
    manager.appendCustomEntry(WORKBENCH_RECORD_ENTRY, {
      kind: WorkbenchRecordKind.Notice,
      watch_entry_id: watchId,
      projects: [
        {
          project_id: NOTICE_PROJECT_ONE,
          name: "shop",
          nodes: [
            noticeNode(NOTICE_NODE_ONE, "Completed"),
            noticeNode(NOTICE_NODE_TWO, "Completed"),
          ],
        },
        {
          project_id: NOTICE_PROJECT_TWO,
          name: "api",
          nodes: [noticeNode(NOTICE_NODE_THREE, "Discarded")],
        },
      ],
    });
    completed(await sendMessage(fixture, host.id, SECOND_REVIEW_REQUEST));
    await untilIdle(fixture, host.id, t.signal);
    const [relay] = relaysOf(fixture.provider.calls.at(-SINGLE)!.messages);
    assert.ok(relay);
    assert.equal(occurrences(relay, "Completed: shop · 2 Completed"), SINGLE);
    assert.equal(occurrences(relay, "Completed: api · 1 Discarded"), SINGLE);
    assert.ok(!relay.includes(watchId));
    assert.ok(!relay.includes("node_ids"));
    assert.ok(!relay.includes(NOTICE_PROJECT_ONE));
  },
);

async function variantConversation(t: TestContext, renameBeforeHost: boolean) {
  const fixture = await workbenchFixture(
    t,
    [fauxAssistantMessage(VARIANT_ANSWER), fauxAssistantMessage(HOST_ANSWER)],
    undefined,
    undefined,
    [OPS, AGENT],
  );
  const variant = completed(
    await fixture.agent["variant.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: AGENT,
          display_name: VARIANT_NAME,
          instruction: VARIANT_INSTRUCTION,
        },
      },
      fixture.options,
    ),
  );
  const host = await createHost(fixture, OPS);
  completed(await sendMessage(fixture, host.id, VARIANT_REQUEST));
  await untilIdle(fixture, host.id, t.signal);
  if (renameBeforeHost)
    completed(
      await fixture.agent["variant.update"](
        {
          params: { variant_id: variant.id },
          query: {},
          body: {
            display_name: RENAMED_VARIANT_NAME,
            instruction: VARIANT_INSTRUCTION,
            expected_revision: variant.revision,
          },
        },
        fixture.options,
      ),
    );
  completed(await sendMessage(fixture, host.id, VARIANT_HOST_REQUEST));
  await untilIdle(fixture, host.id, t.signal);
  return relaysOf(fixture.provider.calls.at(-SINGLE)!.messages);
}

test(
  "(happy path) the next host run receives one relay that names the variant member by its display name",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const relays = await variantConversation(t, false);
    assert.equal(relays.length, SINGLE);
    const [relay] = relays;
    assert.equal(
      occurrences(relay!, `Ulrich to @${VARIANT_NAME}: ${VARIANT_REQUEST}`),
      SINGLE,
    );
    assert.equal(
      occurrences(relay!, `${VARIANT_NAME}: ${VARIANT_ANSWER}`),
      SINGLE,
    );
    assert.ok(!relay!.includes(VARIANT_INSTRUCTION));
    assert.ok(!relay!.includes(VARIANT_HOST_REQUEST));
  },
);

test(
  "(happy path) a rename before the host run changes the name of the variant member in the relay",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const [relay] = await variantConversation(t, true);
    assert.ok(relay);
    assert.equal(
      occurrences(relay, `${RENAMED_VARIANT_NAME}: ${VARIANT_ANSWER}`),
      SINGLE,
    );
    assert.equal(
      occurrences(relay, `Ulrich to @${RENAMED_VARIANT_NAME}: `),
      SINGLE,
    );
    assert.ok(!relay.includes(`${VARIANT_NAME}: ${VARIANT_ANSWER}`));
  },
);
