import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay, setImmediate } from "node:timers/promises";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  getSystemMessageText,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  BASE_PROMPT,
  FORK_SUMMARY_PROMPT,
  GUARD_PROMPT,
  GUARD_SUMMARY_PROMPT,
  SWE_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "../../agent/prompt-assets.ts";
import { directClient } from "../../gateway/index.ts";
import { background } from "../../kernel/context.ts";
import {
  testGuestIdentity,
  testHumanIdentity,
  testReadOnlyIdentity,
} from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import {
  stopAfter,
  temporary,
  temporaryDirectory,
} from "../../kernel/test-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";
import { isString } from "../../kernel/values.ts";
import { getAgentDeclaration } from "../../agent/catalog.ts";
import {
  AGENT_NAMES,
  AgentErrorCode,
  GuardClass,
  GuardTask,
  PromptOrigin,
  PromptPart,
  ToolSource,
} from "../../agent/contract.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  REDACTION_LOG_MESSAGE,
  RestoreReason,
} from "../../agent/hooks/sensitive-text-redaction.ts";
import {
  SensitiveRule,
  SESSION_MARKER_PATTERN,
} from "../../agent/sensitive-text.ts";
import { llmOperations } from "../../llm/contract.ts";
import {
  ActionOutcome,
  AuthorKind,
  GUARD_AUTO_CONFIDENCE,
  GUARD_TOOL_NAME,
  GuardCause,
  MessageDelivery,
  MessageKind,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_EXPIRY_REASON,
  WORKBENCH_OPENING_TEXT,
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WORKBENCH_QUEUE_LIMIT,
  WORKBENCH_REJECTION_REASON,
  WORKBENCH_STREAM_TICK_MS,
  type WorkbenchConfiguration,
  WorkbenchErrorCode,
  WorkbenchGuardReason,
} from "../../workbench/contract.ts";
import { toolName } from "../../workbench/index.ts";
import {
  ImportFormat,
  MissionErrorCode,
  missionOperations,
  NodeState,
} from "../../mission/contract.ts";
import {
  AGENT,
  ANTHROPIC,
  BACKUP,
  BACKUP_KEY,
  callsOf,
  completed,
  COVERING_WORKER_BINDINGS,
  DEFAULT,
  fakeS3,
  forkOf,
  GUARD_AGENT,
  GUARD_MODEL,
  HAIKU,
  heldAnswer,
  invitedProjectIds,
  OFF,
  pass,
  type Persistence,
  PRIMARY_KEY,
  pumped,
  pumpTimers,
  SONNET,
  SPARE_CREDENTIAL,
  SPARE_KEY,
  untilAbort,
  userRequestOf,
  workbenchHarness,
} from "./test-support.ts";
import { type SeededNode, seedEvidence } from "./evidence-test-support.ts";
import { framing, PromptConsumer } from "../../agent/prompt-render.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-test");
const { workbenchFixture } = workbenchHarness(identity);
const REVIEW_AGENT = "re@1";
const OPS = "ops@1";
const LOW = "low" as const;
const CustomType = "custom";
const ModelChange = "model_change";
const ThinkingChange = "thinking_level_change";
const SINGLE = 1;
const NO_QUEUED_MESSAGES = 0;
const NO_UNKEPT = 0;
const UNTAGGED = { agent_name: null, display_name: null };
const GREETING_PREFIX = "Hi, I am ";
const HOST_HOME = "/home/kanthord_host";
const MESSAGE_ENTRY = "message";
const SYSTEM_ROLE = "system";
const USER_ROLE = "user";
const INVALID_OVERRIDE_TEXT = "bell\u0007";
const OVERRIDE_TEXT = "Answer in one sentence.";
const QUESTION = "How many objectives are open?";
const ANSWER = "Two objectives are open.";
const FIRST_MESSAGE = "List the open objectives.";

function failed<T>(
  result: OperationResult<T>,
  status: number,
  code: string,
): void {
  assert.equal(
    result.type,
    OperationResultType.Failure,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
}

async function createSession(
  fixture: Awaited<ReturnType<typeof workbenchFixture>>,
  configuration: WorkbenchConfiguration = {
    agent_provider: DEFAULT,
    model_identifier: SONNET,
    reasoning_effort: OFF,
  },
  agentName = AGENT,
) {
  return completed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: { agent_name: agentName, ...configuration },
      },
      fixture.options,
    ),
  );
}

function entriesOf(
  entries: readonly Record<string, unknown>[],
  type: string,
): Record<string, unknown>[] {
  return entries.filter((entry) => entry.type === type);
}

test("a workbench session is created with its configuration in pi entries", async (t) => {
  const fixture = await workbenchFixture(t);
  const session = await createSession(fixture);
  assert.match(session.id, /^workbench_session_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(session.agent_name, AGENT);
  assert.equal(session.run_active, false);
  assert.deepEqual(session.configuration, {
    agent_provider: DEFAULT,
    model_identifier: SONNET,
    reasoning_effort: OFF,
  });
  const custom = entriesOf(session.entries, CustomType);
  assert.equal(custom.length, SINGLE);
  assert.equal(custom[0]!.customType, WORKBENCH_CONFIGURATION_ENTRY);
  assert.deepEqual(custom[0]!.data, { agent_provider: DEFAULT });
  assert.deepEqual(
    entriesOf(session.entries, ModelChange).map(({ provider, modelId }) => ({
      provider,
      modelId,
    })),
    [{ provider: ANTHROPIC, modelId: SONNET }],
  );
  assert.deepEqual(
    entriesOf(session.entries, ThinkingChange).map(
      ({ thinkingLevel }) => thinkingLevel,
    ),
    [OFF],
  );
  const read = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: session.id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(read, session);
});

test("a configuration change appends the custom entry only when the agent provider changes", async (t) => {
  const fixture = await workbenchFixture(t);
  const session = await createSession(fixture);
  const params = { session_id: session.id };
  const lowHaiku = {
    agent_provider: DEFAULT,
    model_identifier: HAIKU,
    reasoning_effort: LOW,
  };
  assert.deepEqual(
    completed(
      await fixture.workbench["session.configure"](
        { params, query: {}, body: lowHaiku },
        fixture.options,
      ),
    ),
    lowHaiku,
  );
  let read = completed(
    await fixture.workbench["session.get"](
      { params, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(entriesOf(read.entries, CustomType).length, SINGLE);
  assert.equal(entriesOf(read.entries, ModelChange).at(-1)!.modelId, HAIKU);
  assert.equal(
    entriesOf(read.entries, ThinkingChange).at(-1)!.thinkingLevel,
    LOW,
  );
  const backup = { ...lowHaiku, agent_provider: BACKUP };
  completed(
    await fixture.workbench["session.configure"](
      { params, query: {}, body: backup },
      fixture.options,
    ),
  );
  read = completed(
    await fixture.workbench["session.get"](
      { params, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(
    entriesOf(read.entries, CustomType).map(({ data }) => data),
    [{ agent_provider: DEFAULT }, { agent_provider: BACKUP }],
  );
  assert.deepEqual(read.configuration, backup);
});

test("the Agent component refuses an invalid workbench configuration", async (t) => {
  const fixture = await workbenchFixture(t);
  failed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: "unknown@1",
          agent_provider: DEFAULT,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
    HttpStatus.NotFound,
    "agent.catalog.not_found",
  );
  failed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: AGENT,
          agent_provider: "absent",
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
    HttpStatus.NotFound,
    "agent.enablement.provider.not_found",
  );
  failed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: AGENT,
          agent_provider: DEFAULT,
          model_identifier: "absent-model",
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
    HttpStatus.BadRequest,
    "agent.configuration.model_unknown",
  );
  const session = await createSession(fixture);
  failed(
    await fixture.workbench["session.configure"](
      {
        params: { session_id: session.id },
        query: {},
        body: {
          agent_provider: DEFAULT,
          model_identifier: SONNET,
          reasoning_effort: "max" as const,
        },
      },
      fixture.options,
    ),
    HttpStatus.BadRequest,
    "agent.configuration.reasoning_effort_unsupported",
  );
  failed(
    await fixture.workbench["session.get"](
      {
        params: { session_id: "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        query: {},
        body: null,
      },
      fixture.options,
    ),
    HttpStatus.NotFound,
    WorkbenchErrorCode.SessionNotFound,
  );
  failed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agent_name: "unknown@1" }, body: null },
      fixture.options,
    ),
    HttpStatus.NotFound,
    "agent.catalog.not_found",
  );
});

test("the workbench lists and opens no pe@1 session", async (t) => {
  const state = temporaryDirectory();
  const pi = await loadPi();
  const peAgent = "pe@1";
  pi.SessionManager.create(
    join(state, "workbench", peAgent),
    join(state, "pi", "sessions", "workbench", peAgent),
    { id: "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  ).appendMessage({
    role: "user",
    content: FIRST_MESSAGE,
    timestamp: Date.now(),
  });
  const fixture = await workbenchFixture(t, [], state);
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const listed = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(
    listed.items.filter((item) => item.agent_name === peAgent),
    [],
  );
  assert.deepEqual(
    completed(
      await fixture.workbench["session.list"](
        { params: {}, query: { agent_name: peAgent }, body: null },
        fixture.options,
      ),
    ),
    { items: [] },
  );
  failed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agent_name: "unknown@1" }, body: null },
      fixture.options,
    ),
    HttpStatus.NotFound,
    "agent.catalog.not_found",
  );
  failed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: peAgent,
          agent_provider: DEFAULT,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
    HttpStatus.Conflict,
    WorkbenchErrorCode.AgentRefused,
  );
});

test("(security: refused path) workbench.session.create with guard@1 answers a conflict", async (t) => {
  const fixture = await workbenchFixture(t);
  failed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: "guard@1",
          agent_provider: DEFAULT,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
    HttpStatus.Conflict,
    WorkbenchErrorCode.AgentRefused,
  );
});

test("(happy path) agent.list answers every catalog agent in name order with its consumers and tool counts", async (t) => {
  const fixture = await workbenchFixture(t);
  const listed = completed(
    await fixture.agent.list(
      { params: {}, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(
    listed.items.map(({ agent_name }) => agent_name),
    [...AGENT_NAMES].sort(),
  );
  const item = (name: string) =>
    listed.items.find(({ agent_name }) => agent_name === name)!;
  const ops = completed(
    await fixture.agent.get(
      { params: { agent_name: "ops@1" }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(item("ops@1").display_name, OPS_DISPLAY_NAME);
  assert.deepEqual(item("ops@1").worker_names, []);
  assert.deepEqual(item("ops@1").consumers, ["workbench"]);
  assert.equal(
    item("ops@1").tool_counts.operation,
    ops.tools.filter(({ source }) => source === ToolSource.Operation).length,
  );
  assert.equal(item("ops@1").enablement, null);
  assert.deepEqual(item("pe@1").consumers, ["worker"]);
  assert.deepEqual(item("swe@1").consumers, ["workbench", "worker"]);
  assert.deepEqual(item("re@1").consumers, ["workbench", "worker"]);
});

test("a stored session resumes from the last entry of each kind and lists through pi", async (t) => {
  const state = temporaryDirectory();
  const pi = await loadPi();
  const id = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const manager = pi.SessionManager.create(
    join(state, "workbench", AGENT),
    join(state, "pi", "sessions", "workbench", AGENT),
    { id },
  );
  manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
    agent_provider: DEFAULT,
  });
  manager.appendModelChange(ANTHROPIC, SONNET);
  manager.appendThinkingLevelChange(OFF);
  manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
    agent_provider: BACKUP,
  });
  manager.appendModelChange(ANTHROPIC, HAIKU);
  manager.appendThinkingLevelChange(LOW);
  manager.appendMessage({
    role: "user",
    content: FIRST_MESSAGE,
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "None are open." }],
    api: "anthropic-messages",
    provider: ANTHROPIC,
    model: HAIKU,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const fixture = await workbenchFixture(t, [], state);
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const dependencies = (
    fixture.workbenchService as unknown as {
      dependencies: { hostHome: string };
    }
  ).dependencies;
  dependencies.hostHome = HOST_HOME;
  const listed = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agent_name: AGENT }, body: null },
      fixture.options,
    ),
  );
  assert.equal(listed.items.length, SINGLE);
  assert.equal(listed.items[0]!.id, id);
  assert.equal(listed.items[0]!.agent_name, AGENT);
  const everyAgent = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(everyAgent.items, listed.items);
  assert.equal(listed.items[0]!.first_message, FIRST_MESSAGE);
  assert.equal(listed.items[0]!.run_active, false);
  assert.equal(listed.items[0]!.pending_approval, null);
  assert.ok(Number.isSafeInteger(listed.items[0]!.created));
  const read = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(read.resume_command, `pi --session ${manager.getSessionFile()}`);
  dependencies.hostHome = state;
  const homeRead = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(
    homeRead.resume_command,
    `pi --session ~${manager.getSessionFile()!.slice(state.length)}`,
  );
  dependencies.hostHome = HOST_HOME;
  assert.deepEqual(read.configuration, {
    agent_provider: BACKUP,
    model_identifier: HAIKU,
    reasoning_effort: LOW,
  });
  const same = { ...read.configuration };
  completed(
    await fixture.workbench["session.configure"](
      { params: { session_id: id }, query: {}, body: same },
      fixture.options,
    ),
  );
  const again = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(again.entries.length, read.entries.length);
});

test("the workbench credential view exposes only the credential of the configured agent provider", async (t) => {
  const fixture = await workbenchFixture(t);
  const session = await createSession(fixture);
  let requester: typeof identity | undefined = identity;
  const view = fixture.custody.workbenchCredentials({
    session_id: session.id,
    platform: ANTHROPIC,
    requester: () => requester,
    authorize: (tx, human, sessionId) =>
      fixture.workbenchService.authorize(tx, human, sessionId),
  });
  assert.deepEqual(await view.read(ANTHROPIC), {
    type: "api_key",
    key: PRIMARY_KEY,
  });
  assert.equal(await view.read("openai"), undefined);
  assert.deepEqual(await view.list(), [
    { providerId: ANTHROPIC, type: "api_key" },
  ]);
  await assert.rejects(view.delete(ANTHROPIC));
  completed(
    await fixture.workbench["session.configure"](
      {
        params: { session_id: session.id },
        query: {},
        body: {
          agent_provider: BACKUP,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
  );
  assert.deepEqual(await view.read(ANTHROPIC), {
    type: "api_key",
    key: BACKUP_KEY,
  });
  requester = undefined;
  await assert.rejects(view.read(ANTHROPIC));
  requester = identity;
  const other = fixture.custody.workbenchCredentials({
    session_id: "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    platform: ANTHROPIC,
    requester: () => requester,
    authorize: (tx, human, sessionId) =>
      fixture.workbenchService.authorize(tx, human, sessionId),
  });
  await assert.rejects(other.read(ANTHROPIC), {
    code: WorkbenchErrorCode.AuthorizationRefused,
  });
  const enablement = completed(
    await fixture.agent["enablement.get"](
      { params: { agent_name: AGENT }, query: {}, body: null },
      fixture.options,
    ),
  );
  completed(
    await fixture.agent["enablement.disable"](
      {
        params: { agent_name: AGENT },
        query: {},
        body: { expected_revision: enablement.revision },
      },
      fixture.options,
    ),
  );
  await assert.rejects(view.read(ANTHROPIC), {
    code: WorkbenchErrorCode.AuthorizationRefused,
  });
});

type Fixture = Awaited<ReturnType<typeof workbenchFixture>>;
type Entry = Record<string, unknown>;

async function message(fixture: Fixture, sessionId: string, text: string) {
  return fixture.workbench["session.message"](
    { params: { session_id: sessionId }, query: {}, body: { text } },
    fixture.options,
  );
}

async function untilIdle(
  fixture: Fixture,
  sessionId: string,
  signal: AbortSignal,
  after?: string,
): Promise<Entry[]> {
  const entries: Entry[] = [];
  let cursor = after;
  let version: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const answer = completed(
      await pumped(
        fixture.workbench["session.events"](
          {
            params: { session_id: sessionId },
            query: {
              ...(cursor === undefined ? {} : { after: cursor }),
              ...(version === undefined ? {} : { version }),
            },
            body: null,
          },
          fixture.options,
        ),
      ),
    );
    entries.push(...answer.entries);
    cursor = (entries.at(-1)?.id as string | undefined) ?? cursor;
    version = answer.version;
    if (
      !answer.snapshot.run_active &&
      answer.snapshot.queue.length === NO_QUEUED_MESSAGES
    )
      return entries;
  }
}

function texts(entries: readonly Entry[], role: string): string[] {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; content: unknown })
    .filter((message) => message.role === role)
    .map((message) =>
      isString(message.content)
        ? message.content
        : (message.content as { type: string; text?: string }[])
            .map((block) => block.text ?? "")
            .join(""),
    )
    .filter(
      (text) =>
        text !== WORKBENCH_OPENING_TEXT && !text.startsWith(GREETING_PREFIX),
    );
}

test("a message runs the agent while a long poll follows the run to its end", async (t) => {
  const gate = Promise.withResolvers<void>();
  const fixture = await workbenchFixture(t, [
    async () => {
      await gate.promise;
      return fauxAssistantMessage(ANSWER);
    },
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  const accepted = await message(fixture, sessionId, QUESTION);
  assert.equal(accepted.type, OperationResultType.Completed);
  assert.ok(accepted.type === OperationResultType.Completed);
  assert.equal(accepted.status, HttpStatus.Accepted);
  assert.deepEqual(accepted.data, {
    session_id: sessionId,
    agent_name: AGENT,
    run_active: true,
    queued_message_id: null,
    cleared: [],
    kind: MessageKind.Run,
  });
  const during = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(during.run_active, true);
  assert.deepEqual(during.entries, session.entries);
  const last = session.entries.at(-1)!.id;
  await untilProviderCall(fixture, t.signal);
  const first = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: { after: last }, body: null },
      fixture.options,
    ),
  );
  assert.equal(first.snapshot.run_active, true);
  assert.deepEqual(texts(first.entries, "user"), [QUESTION]);
  gate.resolve();
  const rest = await untilIdle(fixture, sessionId, t.signal, last);
  assert.deepEqual(texts(rest, "assistant"), [ANSWER]);
  const after = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(after.run_active, false);
  assert.deepEqual(texts(after.entries, "assistant"), [ANSWER]);
  const call = fixture.provider.calls[0]!;
  assert.ok(call.systemPrompt?.includes(BASE_PROMPT));
  assert.ok(call.systemPrompt?.includes(SWE_AGENT_PROMPT));
  assert.ok(
    call.systemPrompt?.includes(
      `${WORKBENCH_PROMPT}\n\n${framing(SHIPPED_TEMPLATES, PromptConsumer.Workbench)}`,
    ),
  );
  const [pin] = call.messages;
  assert.equal(pin?.role, SYSTEM_ROLE);
  assert.ok(
    getSystemMessageText(pin as SystemMessage).includes(WORKBENCH_PROMPT),
  );
  assert.ok(
    !JSON.stringify(
      call.messages.filter((entry) => entry.role !== SYSTEM_ROLE),
    ).includes("## Human interlocutor"),
  );
  assert.equal(call.apiKey, PRIMARY_KEY);
});

test("an override file replaces the shipped workbench text and an invalid one refuses the session with a conflict", async (t) => {
  const agentDirectory = temporary(t);
  const overridePath = join(agentDirectory, "workbench.md");
  writeFileSync(overridePath, OVERRIDE_TEXT);
  const fixture = await workbenchFixture(
    t,
    [fauxAssistantMessage(ANSWER)],
    undefined,
    agentDirectory,
  );
  const session = await createSession(fixture);
  completed(await message(fixture, session.id, QUESTION));
  await untilIdle(fixture, session.id, t.signal);
  const call = fixture.provider.calls[0]!;
  assert.ok(call.systemPrompt?.includes(OVERRIDE_TEXT));
  assert.ok(!call.systemPrompt?.includes(WORKBENCH_PROMPT));
  writeFileSync(overridePath, INVALID_OVERRIDE_TEXT);
  const refused = await fixture.workbench["session.create"](
    {
      params: {},
      query: {},
      body: {
        agent_name: AGENT,
        agent_provider: DEFAULT,
        model_identifier: SONNET,
        reasoning_effort: OFF,
      },
    },
    fixture.options,
  );
  failed(refused, HttpStatus.Conflict, AgentErrorCode.PromptTemplateInvalid);
  assert.ok(refused.type === OperationResultType.Failure);
  assert.deepEqual(refused.error.error.details, {
    file: "workbench.md",
    path: overridePath,
    reason: "control_character",
  });
});

test("(security: refused path) agent.get of guard@1 answers the shipped text and reads no override file", async (t) => {
  const agentDirectory = temporary(t);
  writeFileSync(join(agentDirectory, "guard@1.md"), OVERRIDE_TEXT);
  writeFileSync(join(agentDirectory, "guard.md"), OVERRIDE_TEXT);
  writeFileSync(join(agentDirectory, "base.md"), OVERRIDE_TEXT);
  const fixture = await workbenchFixture(t, [], undefined, agentDirectory);
  const guard = completed(
    await fixture.agent.get(
      { params: { agent_name: "guard@1" }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(guard.prompt.final, GUARD_PROMPT);
  assert.deepEqual(
    guard.prompt.parts?.map(({ origin }) => origin),
    [PromptOrigin.Binary],
  );
});

async function guardPrompt(
  fixture: Awaited<ReturnType<typeof workbenchFixture>>,
  query: { task?: GuardTask },
) {
  return completed(
    await fixture.agent.get(
      { params: { agent_name: "guard@1" }, query, body: null },
      fixture.options,
    ),
  ).prompt;
}

test("(happy path) agent.get of guard@1 with task call or no task answers the guard.md part only", async (t) => {
  const fixture = await workbenchFixture(t, []);
  for (const query of [{ task: GuardTask.Call }, {}]) {
    const prompt = await guardPrompt(fixture, query);
    assert.equal(prompt.final, GUARD_PROMPT);
    assert.deepEqual(
      prompt.parts?.map(({ part, name }) => [part, name]),
      [[PromptPart.Role, "guard.md"]],
    );
  }
});

test("(happy path) agent.get of guard@1 with task summary answers the guard-summary.md part only", async (t) => {
  const fixture = await workbenchFixture(t, []);
  const prompt = await guardPrompt(fixture, { task: GuardTask.Summary });
  assert.equal(prompt.final, GUARD_SUMMARY_PROMPT);
  assert.deepEqual(
    prompt.parts?.map(({ part, name, origin, text }) => [
      part,
      name,
      origin,
      text,
    ]),
    [
      [
        PromptPart.Role,
        "guard-summary.md",
        PromptOrigin.Binary,
        GUARD_SUMMARY_PROMPT,
      ],
    ],
  );
});

test("(security: argument guard) agent.get of swe@1 with task summary answers a validation failure", async (t) => {
  const fixture = await workbenchFixture(t, []);
  failed(
    await fixture.agent.get(
      {
        params: { agent_name: "swe@1" },
        query: { task: GuardTask.Summary },
        body: null,
      },
      fixture.options,
    ),
    HttpStatus.BadRequest,
    "gateway.request.validation_failed",
  );
});

test("(security: refused path) agent.get of guard@1 with task summary reads no override file", async (t) => {
  const agentDirectory = temporary(t);
  for (const name of ["guard@1.md", "base.md", "guard-summary.md"])
    writeFileSync(join(agentDirectory, name), OVERRIDE_TEXT);
  const fixture = await workbenchFixture(t, [], undefined, agentDirectory);
  const prompt = await guardPrompt(fixture, { task: GuardTask.Summary });
  assert.equal(prompt.final, GUARD_SUMMARY_PROMPT);
  assert.deepEqual(
    prompt.parts?.map(({ origin }) => origin),
    [PromptOrigin.Binary],
  );
});

test("an abort stops the active run", async (t) => {
  const fixture = await workbenchFixture(t, [
    async (_context, options) => {
      await new Promise<void>((resolve) =>
        options?.signal?.addEventListener("abort", () => resolve(), {
          once: true,
        }),
      );
      return fauxAssistantMessage(ANSWER);
    },
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  assert.deepEqual(
    completed(
      await fixture.workbench["session.abort"](
        { params: { session_id: sessionId }, query: {}, body: null },
        fixture.options,
      ),
    ),
    { session_id: sessionId, run_active: false, cleared: [] },
  );
  const read = completed(
    await fixture.workbench["session.get"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(read.run_active, false);
  assert.ok(!texts(read.entries, "assistant").includes(ANSWER));
});

test("a session resumes after a restart with its configuration and its completed runs", async (t) => {
  const state = temporaryDirectory();
  const first = await workbenchFixture(
    t,
    [fauxAssistantMessage(ANSWER)],
    state,
  );
  const session = await createSession(first, {
    agent_provider: BACKUP,
    model_identifier: HAIKU,
    reasoning_effort: LOW,
  });
  completed(await message(first, session.id, QUESTION));
  await untilIdle(first, session.id, t.signal);
  completed(
    await first.workbench["session.abort"](
      { params: { session_id: session.id }, query: {}, body: null },
      first.options,
    ),
  );
  assert.equal((await first.workbenchService.stop()) ?? undefined, undefined);
  const second = await workbenchFixture(
    t,
    [fauxAssistantMessage("Still two.")],
    state,
  );
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const listed = completed(
    await second.workbench["session.list"](
      { params: {}, query: { agent_name: AGENT }, body: null },
      second.options,
    ),
  );
  assert.deepEqual(
    listed.items.map(({ id }) => id),
    [session.id],
  );
  const resumed = completed(
    await second.workbench["session.get"](
      { params: { session_id: session.id }, query: {}, body: null },
      second.options,
    ),
  );
  assert.deepEqual(resumed.configuration, session.configuration);
  assert.deepEqual(texts(resumed.entries, "assistant"), [ANSWER]);
  completed(await message(second, session.id, "And now?"));
  const entries = await untilIdle(
    second,
    session.id,
    t.signal,
    resumed.entries.at(-1)!.id,
  );
  assert.deepEqual(texts(entries, "assistant"), ["Still two."]);
  const call = second.provider.calls[0]!;
  assert.ok(JSON.stringify(call.messages).includes(QUESTION));
  assert.equal(call.apiKey, BACKUP_KEY);
});

const TOOL_USE = "toolUse" as const;
const TOOL_RESULT = "toolResult";
const OPS_DISPLAY_NAME = "Yumi";
const PROJECT_RESUME = "project.resume";
const TWO_RESULTS = 2;
const NO_RECORDS = 0;
const OFFER_ACTION = "offer_action";
const NODE_DISCARD = "mission.node.discard";
const NODE_RESUME = "mission.node.resume";
const RECORD_ENTRY = "kanthord.workbench.record";
const PROJECT_NAME = "operations";
const UNKNOWN_NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIRST_BINDING_SET = 1;
const NO_PAUSE = null;
const CRITERION_SET = "mission.criterion.set";
const ORIGINAL_CRITERION = "The thread is reviewed";
const NEW_CRITERION = "The thread is reviewed twice";
const UNAVAILABLE_GUARD = {
  cause: "unavailable",
  reason: null,
  confidence: null,
};
const NO_TOOLS = 0;
const NO_DESCRIPTION = "";
const OPS_OPERATION_COUNT = 36;
const NODE_REVIEW_READ_COUNT = 6;
const FAST_POLL_MS = 2000;

function toolCall(name: string, args: Parameters<typeof fauxToolCall>[1]) {
  return fauxAssistantMessage(fauxToolCall(name, args), {
    stopReason: TOOL_USE,
  });
}

function toolResults(entries: readonly Entry[]) {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map(
      (entry) =>
        entry.message as {
          role: string;
          toolName?: string;
          isError?: boolean;
          content: { type: string; text?: string }[];
        },
    )
    .filter((message) => message.role === TOOL_RESULT)
    .map((message) => ({
      toolName: message.toolName,
      isError: message.isError,
      text: message.content.map((block) => block.text ?? "").join(""),
    }));
}

function resumeInput(projectId: string) {
  return { params: { project_id: projectId }, query: {}, body: null };
}

function resumeToolInput(projectId: string) {
  return { params: { project_id: projectId } };
}

async function pausedProject(fixture: Fixture): Promise<string> {
  const project = completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: PROJECT_NAME } },
      fixture.options,
    ),
  );
  completed(
    await fixture.projects.pause(
      resumeInput(project.id) as never,
      fixture.options,
    ),
  );
  return project.id;
}

async function pausedAt(
  fixture: Fixture,
  projectId: string,
): Promise<number | null> {
  return completed(
    await fixture.projects.get(
      resumeInput(projectId) as never,
      fixture.options,
    ),
  ).paused_at;
}

interface CreatedNode {
  projectId: string;
  nodeId: string;
  missionVersion: number;
}

async function createNode(fixture: Fixture): Promise<string> {
  return (await createdNode(fixture)).nodeId;
}

async function createdNode(
  fixture: Fixture,
  projectName = PROJECT_NAME,
): Promise<CreatedNode> {
  const project = completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: projectName } },
      fixture.options,
    ),
  );
  completed(
    await fixture.projects["bindingSet.write"](
      {
        params: { project_id: project.id },
        query: {},
        body: {
          version: FIRST_BINDING_SET,
          bindings: COVERING_WORKER_BINDINGS,
        },
      } as never,
      fixture.options,
    ),
  );
  const mission = completed(
    await fixture.missions.get(
      { params: { project_id: project.id }, query: {}, body: null },
      fixture.options,
    ),
  );
  const created = completed(
    await fixture.missions["node.create"](
      {
        params: { mission_id: mission.id },
        query: {},
        body: {
          filename: "review.md",
          content: {
            name: "Review the thread",
            requirement: "Review the thread",
            criterion: "The thread is reviewed",
            verifications: ["true"],
            bindings: [],
            intent: "examine",
          },
          tasks: [],
          reason: "plan",
          expected_mission_version: mission.version,
        },
      } as never,
      fixture.options,
    ),
  ) as { revisions: { node_id: string }[]; mission_version: number };
  return {
    projectId: project.id,
    nodeId: created.revisions[0]!.node_id,
    missionVersion: created.mission_version,
  };
}

function criterionToolInput(created: CreatedNode) {
  return {
    params: { node_id: created.nodeId },
    body: {
      criterion: NEW_CRITERION,
      verifications: ["true"],
      reason: "tighten",
      expected_revision: FIRST_REVISION,
      expected_mission_version: created.missionVersion,
    },
  };
}

async function criterionOf(fixture: Fixture, nodeId: string): Promise<string> {
  return completed(
    await fixture.missions["node.get"](
      { params: { node_id: nodeId }, query: {}, body: null },
      fixture.options,
    ),
  ).content.criterion;
}

async function cardFixture(t: TestContext, stateDirectory?: string) {
  const target = { input: {} };
  const fixture = await workbenchFixture(
    t,
    [
      () => toolCall(toolName(CRITERION_SET), target.input),
      fauxAssistantMessage(ANSWER),
    ],
    stateDirectory,
    undefined,
    [OPS, AGENT, REVIEW_AGENT],
  );
  const created = await createdNode(fixture);
  target.input = criterionToolInput(created);
  const session = await createSession(fixture, undefined, OPS);
  return { fixture, session, nodeId: created.nodeId, input: target.input };
}

async function untilApproval(
  fixture: Fixture,
  sessionId: string,
  signal: AbortSignal,
) {
  let version: number | undefined;
  for (;;) {
    signal.throwIfAborted();
    const answer = completed(
      await pumped(
        fixture.workbench["session.events"](
          {
            params: { session_id: sessionId },
            query: version === undefined ? {} : { version },
            body: null,
          },
          fixture.options,
        ),
      ),
    );
    if (answer.snapshot.pending_approval)
      return answer.snapshot.pending_approval;
    assert.ok(answer.snapshot.run_active);
    version = answer.version;
  }
}

test("a poll answers at once when the snapshot changed after the version that the client holds", async (t) => {
  const { fixture, session } = await cardFixture(t);
  const sessionId = session.id;
  const before = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  completed(await message(fixture, sessionId, QUESTION));
  await untilApproval(fixture, sessionId, t.signal);
  const all = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  const last = all.entries.at(-1)?.id as string;
  const started = performance.now();
  const answer = completed(
    await fixture.workbench["session.events"](
      {
        params: { session_id: sessionId },
        query: { after: last, version: before.version },
        body: null,
      },
      fixture.options,
    ),
  );
  assert.ok(performance.now() - started < FAST_POLL_MS);
  assert.deepEqual(answer.entries, []);
  assert.ok(answer.snapshot.pending_approval);
  assert.ok(answer.version > before.version);
});

test("(happy path) the tool table of each workbench agent holds its built-in tools and its listed operation tools", async (t) => {
  const agents = [OPS, AGENT, REVIEW_AGENT];
  const fixture = await workbenchFixture(
    t,
    agents.map(() => fauxAssistantMessage(ANSWER)),
    undefined,
    undefined,
    agents,
  );
  for (const [index, agentName] of agents.entries()) {
    const session = await createSession(fixture, undefined, agentName);
    completed(await message(fixture, session.id, QUESTION));
    await untilIdle(fixture, session.id, t.signal);
    const tools = fixture.provider.tools[index]!;
    const { builtin, operation, workbench } =
      getAgentDeclaration(agentName)!.tools;
    assert.deepEqual(
      [...tools].sort(),
      [
        ...builtin,
        ...operation.map(toolName),
        ...workbench,
        OFFER_ACTION,
      ].sort(),
      agentName,
    );
    for (const name of [
      "agent.get",
      "agent.enablement.put",
      "project.create",
      "llm.credential.create",
      "repository.credential.create",
      "storage.credential.create",
      "intake.inbound.get",
      "intake.storage.get",
      "mission.evidence.asset.content.get",
      "intake.credential.create",
      "intake.credential.rotate",
      "intake.credential.check",
      "project.credential.create",
      "project.credential.rotate",
      "project.credential.check",
      "worker.handover",
      "evidence-upload",
    ])
      assert.ok(!tools.includes(toolName(name)), `${agentName} ${name}`);
    for (const name of tools) assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
  }
});

test("(happy path) agent.get answers the display name, the identity part and the operation tools of each workbench agent", async (t) => {
  const fixture = await workbenchFixture(t);
  const read = async (agentName: string) =>
    completed(
      await fixture.agent.get(
        { params: { agent_name: agentName }, query: {}, body: null },
        fixture.options,
      ),
    );
  const ops = await read(OPS);
  assert.equal(ops.display_name, OPS_DISPLAY_NAME);
  assert.equal(
    ops.tools.filter(({ source }) => source === ToolSource.Operation).length,
    OPS_OPERATION_COUNT,
  );
  assert.deepEqual(
    ops.prompt.parts!.map(({ part }) => part),
    [
      PromptPart.Standard,
      PromptPart.Identity,
      PromptPart.Role,
      PromptPart.Workbench,
      PromptPart.Framing,
    ],
  );
  assert.ok(
    ops.prompt
      .parts!.find(({ part }) => part === PromptPart.Identity)!
      .text!.startsWith(`Your name is ${OPS_DISPLAY_NAME}.`),
  );
  for (const agentName of [AGENT, REVIEW_AGENT]) {
    const { tools } = await read(agentName);
    const declared = getAgentDeclaration(agentName)!.tools;
    const local = tools.slice(
      NO_TOOLS,
      declared.builtin.length + declared.host.length,
    );
    const operations = tools.slice(
      local.length,
      local.length + declared.operation.length,
    );
    assert.ok(
      local.every(
        ({ source, description, guard_class }) =>
          source !== ToolSource.Operation &&
          description === NO_DESCRIPTION &&
          guard_class === null,
      ),
      agentName,
    );
    assert.equal(operations.length, NODE_REVIEW_READ_COUNT, agentName);
    assert.deepEqual(
      operations.map(({ name, source, guard_class }) => [
        name,
        source,
        guard_class,
      ]),
      declared.operation.map((id) => [
        toolName(id),
        ToolSource.Operation,
        GuardClass.Read,
      ]),
      agentName,
    );
  }
});

test("(happy path) a read tool of ops@1 succeeds and a refusal returns the owning service code", async (t) => {
  const fixture = await workbenchFixture(
    t,
    [
      toolCall(toolName("project.list"), {
        query: {},
      }),
      toolCall(toolName("mission.node.get"), {
        params: { node_id: UNKNOWN_NODE },
      }),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [OPS],
  );
  completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: PROJECT_NAME } },
      fixture.options,
    ),
  );
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(entries);
  assert.deepEqual(
    results.map(({ toolName, isError }) => ({ toolName, isError })),
    [
      { toolName: toolName("project.list"), isError: false },
      { toolName: toolName("mission.node.get"), isError: true },
    ],
  );
  assert.ok(results[0]!.text.includes(PROJECT_NAME));
  assert.ok(results[1]!.text.startsWith(`${MissionErrorCode.NodeNotFound}:`));
  assert.deepEqual(texts(entries, "assistant").at(-1), ANSWER);
});

test("(happy path) a read tool and a built-in tool of swe@1 run at once", async (t) => {
  const target = { nodeId: "" };
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(toolName("mission.node.get"), {
              params: { node_id: target.nodeId },
            }),
            fauxToolCall("ls", { path: "." }),
          ],
          { stopReason: TOOL_USE },
        ),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [AGENT, REVIEW_AGENT],
  );
  target.nodeId = await createNode(fixture);
  const session = await createSession(fixture);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(entries);
  assert.deepEqual(
    results
      .map(({ toolName, isError }) => ({ toolName, isError }))
      .sort((a, b) => a.toolName!.localeCompare(b.toolName!)),
    [
      { toolName: "ls", isError: false },
      { toolName: toolName("mission.node.get"), isError: false },
    ],
  );
  assert.ok(
    results
      .find((result) => result.toolName === toolName("mission.node.get"))!
      .text.includes(target.nodeId),
  );
  assert.deepEqual(texts(entries, "assistant").at(-1), ANSWER);
});

test("a mutation tool runs only after the human approves the call", async (t) => {
  const { fixture, session, nodeId, input } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  assert.equal(pending.operation_id, CRITERION_SET);
  assert.deepEqual(pending.input, input);
  assert.deepEqual(pending.guard, UNAVAILABLE_GUARD);
  assert.equal(await criterionOf(fixture, nodeId), ORIGINAL_CRITERION);
  failed(
    await fixture.workbench["session.approve"](
      {
        params: { session_id: sessionId },
        query: {},
        body: { tool_call_id: "absent", approved: true },
      },
      fixture.options,
    ),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ApprovalNotFound,
  );
  assert.deepEqual(
    completed(
      await fixture.workbench["session.approve"](
        {
          params: { session_id: sessionId },
          query: {},
          body: { tool_call_id: pending.tool_call_id, approved: true },
        },
        fixture.options,
      ),
    ),
    {
      session_id: sessionId,
      tool_call_id: pending.tool_call_id,
      approved: true,
    },
  );
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError }) => isError),
    [false],
  );
  assert.equal(await criterionOf(fixture, nodeId), NEW_CRITERION);
});

async function listedSession(fixture: Fixture, sessionId: string) {
  const listed = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agent_name: OPS }, body: null },
      fixture.options,
    ),
  );
  return listed.items.find(({ id }) => id === sessionId);
}

test("the session list names the run and the pending approval of an open session without the input", async (t) => {
  const { fixture, session } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  const waiting = await listedSession(fixture, sessionId);
  assert.equal(waiting?.run_active, true);
  assert.deepEqual(waiting?.pending_approval, {
    tool_call_id: pending.tool_call_id,
    operation_id: CRITERION_SET,
  });
  completed(
    await fixture.workbench["session.approve"](
      {
        params: { session_id: sessionId },
        query: {},
        body: { tool_call_id: pending.tool_call_id, approved: true },
      },
      fixture.options,
    ),
  );
  await untilIdle(fixture, sessionId, t.signal);
  const idle = await listedSession(fixture, sessionId);
  assert.equal(idle?.run_active, false);
  assert.equal(idle?.pending_approval, null);
});

test("a rejected call reaches the agent as a blocked call", async (t) => {
  const { fixture, session, nodeId } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  completed(
    await fixture.workbench["session.approve"](
      {
        params: { session_id: sessionId },
        query: {},
        body: { tool_call_id: pending.tool_call_id, approved: false },
      },
      fixture.options,
    ),
  );
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(toolResults(entries), [
    {
      toolName: toolName(CRITERION_SET),
      isError: true,
      text: WORKBENCH_REJECTION_REASON,
    },
  ]);
  assert.equal(await criterionOf(fixture, nodeId), ORIGINAL_CRITERION);
});

test("an abort rejects every pending approval", async (t) => {
  const { fixture, session, nodeId } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  completed(
    await fixture.workbench["session.abort"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  const answer = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.equal(answer.snapshot.run_active, false);
  assert.equal(answer.snapshot.pending_approval, null);
  failed(
    await fixture.workbench["session.approve"](
      {
        params: { session_id: sessionId },
        query: {},
        body: { tool_call_id: pending.tool_call_id, approved: true },
      },
      fixture.options,
    ),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ApprovalNotFound,
  );
  assert.equal(await criterionOf(fixture, nodeId), ORIGINAL_CRITERION);
});

const SETTLE_TURNS = 20;
const ASSISTANT_ROLE = "assistant";

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  pumpTimers(t);
}

async function snapshotOf(fixture: Fixture, sessionId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
}

async function decide(
  fixture: Fixture,
  sessionId: string,
  toolCallId: string,
  approved: boolean,
) {
  return fixture.workbench["session.approve"](
    {
      params: { session_id: sessionId },
      query: {},
      body: { tool_call_id: toolCallId, approved },
    },
    fixture.options,
  );
}

test("(happy path) a card with no decision expires, returns the expiry reason and ends the run", async (t) => {
  enableTimers(t);
  const { fixture, session, nodeId } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(toolResults(entries), [
    {
      toolName: toolName(CRITERION_SET),
      isError: true,
      text: WORKBENCH_EXPIRY_REASON,
    },
  ]);
  assert.equal(await criterionOf(fixture, nodeId), ORIGINAL_CRITERION);
  const answer = await snapshotOf(fixture, sessionId);
  assert.equal(answer.snapshot.pending_approval, null);
  assert.equal(
    (await listedSession(fixture, sessionId))?.pending_approval,
    null,
  );
  assert.equal(fixture.provider.calls.length, SINGLE);
  failed(
    await decide(fixture, sessionId, pending.tool_call_id, true),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ApprovalNotFound,
  );
});

async function untilPendingApproval(
  fixture: Fixture,
  sessionId: string,
  signal: AbortSignal,
) {
  for (;;) {
    signal.throwIfAborted();
    const answer = await snapshotOf(fixture, sessionId);
    if (answer.snapshot.pending_approval)
      return answer.snapshot.pending_approval;
    await setImmediate();
  }
}

test("(invariant guard) an approve one millisecond before the expiry runs the call and a later tick changes nothing", async (t) => {
  enableTimers(t);
  const { fixture, session, nodeId } = await cardFixture(t);
  const sessionId = session.id;
  const wait = fixture.config.workbench.approval_wait_ms;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilPendingApproval(fixture, sessionId, t.signal);
  t.mock.timers.tick(wait - SINGLE);
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.pending_approval
      ?.tool_call_id,
    pending.tool_call_id,
  );
  completed(await decide(fixture, sessionId, pending.tool_call_id, true));
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError }) => isError),
    [false],
  );
  assert.equal(await criterionOf(fixture, nodeId), NEW_CRITERION);
  t.mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  const before = await snapshotOf(fixture, sessionId);
  t.mock.timers.tick(wait);
  await setImmediate();
  const after = await snapshotOf(fixture, sessionId);
  assert.equal(after.version, before.version);
  assert.equal(after.snapshot.run_active, false);
});

test("(invariant guard) an abort and then a full tick leave the version unchanged", async (t) => {
  enableTimers(t);
  const { fixture, session } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilApproval(fixture, sessionId, t.signal);
  completed(
    await fixture.workbench["session.abort"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  t.mock.timers.tick(WORKBENCH_STREAM_TICK_MS);
  const before = await snapshotOf(fixture, sessionId);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  await setImmediate();
  assert.equal((await snapshotOf(fixture, sessionId)).version, before.version);
});

test("(security) the expiry of the first mutation of a batch ends the run before the second card and any provider call", async (t) => {
  enableTimers(t);
  const target = { input: {} };
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(toolName(CRITERION_SET), target.input),
            fauxToolCall(toolName(CRITERION_SET), target.input),
          ],
          { stopReason: TOOL_USE },
        ),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [OPS, AGENT, REVIEW_AGENT],
  );
  const created = await createdNode(fixture);
  target.input = criterionToolInput(created);
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, QUESTION));
  await untilApproval(fixture, session.id, t.signal);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError, text }) => ({ isError, text })),
    [{ isError: true, text: WORKBENCH_EXPIRY_REASON }],
  );
  assert.equal(
    (await snapshotOf(fixture, session.id)).snapshot.pending_approval,
    null,
  );
  assert.equal(await criterionOf(fixture, created.nodeId), ORIGINAL_CRITERION);
  assert.equal(fixture.provider.calls.length, SINGLE);
});

test("(invariant guard) a service stop with a pending card and then a full tick throws nothing and notifies nothing", async (t) => {
  enableTimers(t);
  const { fixture, session } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilApproval(fixture, sessionId, t.signal);
  const notify = t.mock.method(
    fixture.workbenchService as unknown as { notify(): void },
    "notify",
  );
  await fixture.workbenchService.stop();
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
  const notified = notify.mock.callCount();
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  await setImmediate();
  assert.equal(notify.mock.callCount(), notified);
});

test("(invariant guard) a pending card at the service stop leaves a tool call with no tool result and the next run completes", async (t) => {
  enableTimers(t);
  const state = temporaryDirectory();
  const first = await cardFixture(t, state);
  completed(await message(first.fixture, first.session.id, QUESTION));
  await untilApproval(first.fixture, first.session.id, t.signal);
  await first.fixture.workbenchService.stop();
  const second = await workbenchFixture(
    t,
    [fauxAssistantMessage(ANSWER)],
    state,
    undefined,
    [OPS],
  );
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const resumed = completed(
    await second.workbench["session.get"](
      { params: { session_id: first.session.id }, query: {}, body: null },
      second.options,
    ),
  );
  assert.deepEqual(toolResults(resumed.entries), []);
  assert.ok(JSON.stringify(resumed.entries).includes(toolName(CRITERION_SET)));
  completed(await message(second, first.session.id, FIRST_MESSAGE));
  const entries = await untilIdle(
    second,
    first.session.id,
    t.signal,
    resumed.entries.at(-1)!.id,
  );
  assert.deepEqual(texts(entries, "assistant"), [ANSWER]);
  const roles = second.provider.calls[0]!.messages as {
    role: string;
    content: unknown;
  }[];
  assert.ok(
    roles.some(
      ({ role, content }) =>
        role === ASSISTANT_ROLE &&
        JSON.stringify(content).includes('"type":"toolCall"'),
    ),
  );
  assert.ok(roles.every(({ role }) => role !== TOOL_RESULT));
});

const SECOND_ANSWER = "Second answer.";
const THIRD_ANSWER = "Third answer.";
const FIRST_QUEUED = "First queued message.";
const SECOND_QUEUED = "Second queued message.";
const LAUNCH_FAILURE = "launch failed";
const SECOND_HUMAN = testHumanIdentity("kanthord", "Grace", "workbench-test-2");

function replaceMessage(fixture: Fixture, sessionId: string, text: string) {
  return fixture.workbench["session.message"](
    {
      params: { session_id: sessionId },
      query: {},
      body: { text, delivery: MessageDelivery.Replace },
    },
    fixture.options,
  );
}

function stopSession(fixture: Fixture, sessionId: string) {
  return fixture.workbench["session.abort"](
    { params: { session_id: sessionId }, query: {}, body: null },
    fixture.options,
  );
}

async function untilProviderCall(fixture: Fixture, signal: AbortSignal) {
  while (fixture.provider.calls.length < SINGLE) {
    signal.throwIfAborted();
    await setImmediate();
  }
}

async function queueMessage(
  fixture: Fixture,
  sessionId: string,
  text: string,
  options = fixture.options,
) {
  const accepted = await fixture.workbench["session.message"](
    { params: { session_id: sessionId }, query: {}, body: { text } },
    options,
  );
  return completed(accepted);
}

async function queuedId(fixture: Fixture, sessionId: string, text: string) {
  const accepted = await queueMessage(fixture, sessionId, text);
  assert.ok(accepted.queued_message_id);
  return accepted.queued_message_id;
}

function removeQueued(
  fixture: Fixture,
  sessionId: string,
  queuedMessageId: string,
) {
  return fixture.workbench["session.queue.remove"](
    {
      params: { session_id: sessionId, queued_message_id: queuedMessageId },
      query: {},
      body: null,
    },
    fixture.options,
  );
}

test("(happy path) a message during a run waits in the queue and runs after the run in order of acceptance", async (t) => {
  const first = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(t, [
    first.step,
    fauxAssistantMessage(SECOND_ANSWER),
    fauxAssistantMessage(THIRD_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const accepted = await message(fixture, sessionId, FIRST_QUEUED);
  assert.ok(accepted.type === OperationResultType.Completed);
  assert.equal(accepted.status, HttpStatus.Accepted);
  const firstId = accepted.data.queued_message_id;
  const secondId = await queuedId(fixture, sessionId, SECOND_QUEUED);
  assert.ok(firstId);
  assert.deepEqual((await snapshotOf(fixture, sessionId)).snapshot.queue, [
    { id: firstId, text: FIRST_QUEUED, ...UNTAGGED },
    { id: secondId, text: SECOND_QUEUED, ...UNTAGGED },
  ]);
  first.gate.resolve();
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(texts(entries, "user"), [
    QUESTION,
    FIRST_QUEUED,
    SECOND_QUEUED,
  ]);
  assert.deepEqual(texts(entries, "assistant"), [
    ANSWER,
    SECOND_ANSWER,
    THIRD_ANSWER,
  ]);
  assert.deepEqual((await snapshotOf(fixture, sessionId)).snapshot.queue, []);
});

test("(invariant guard) a message between the end of the agent and the settle of the run queues and runs next", async (t) => {
  const fixture = await workbenchFixture(t, [
    fauxAssistantMessage(ANSWER),
    fauxAssistantMessage(SECOND_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  type Notified = { run: { ended: boolean } | null };
  const service = fixture.workbenchService as unknown as {
    notify(session: Notified): void;
  };
  const notify = service.notify.bind(service);
  let sent: ReturnType<typeof queueMessage> | null = null;
  t.mock.method(service, "notify", (notified: Notified) => {
    notify(notified);
    if (notified.run?.ended && !sent)
      sent = queueMessage(fixture, sessionId, FIRST_QUEUED);
  });
  completed(await message(fixture, sessionId, QUESTION));
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.ok(sent);
  assert.ok(
    (await (sent as ReturnType<typeof queueMessage>)).queued_message_id,
  );
  assert.deepEqual(texts(entries, "user"), [QUESTION, FIRST_QUEUED]);
  assert.deepEqual(texts(entries, "assistant"), [ANSWER, SECOND_ANSWER]);
});

test("(happy path) a removed queued message answers 200, then 404, and never runs", async (t) => {
  const first = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(t, [
    first.step,
    fauxAssistantMessage(SECOND_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const removedId = await queuedId(fixture, sessionId, FIRST_QUEUED);
  const keptId = await queuedId(fixture, sessionId, SECOND_QUEUED);
  assert.deepEqual(
    completed(await removeQueued(fixture, sessionId, removedId)),
    {
      session_id: sessionId,
      queued_message_id: removedId,
    },
  );
  failed(
    await removeQueued(fixture, sessionId, removedId),
    HttpStatus.NotFound,
    WorkbenchErrorCode.QueuedMessageNotFound,
  );
  assert.deepEqual(
    (await snapshotOf(fixture, sessionId)).snapshot.queue.map(({ id }) => id),
    [keptId],
  );
  first.gate.resolve();
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(texts(entries, "user"), [QUESTION, SECOND_QUEUED]);
});

test("(security) the eleventh queued message answers 409 queue_full", async (t) => {
  const fixture = await workbenchFixture(t, [untilAbort(ANSWER)]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  for (let count = 0; count < WORKBENCH_QUEUE_LIMIT; count++)
    await queuedId(fixture, sessionId, `${FIRST_QUEUED} ${count}`);
  failed(
    await message(fixture, sessionId, SECOND_QUEUED),
    HttpStatus.Conflict,
    WorkbenchErrorCode.QueueFull,
  );
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.queue.length,
    WORKBENCH_QUEUE_LIMIT,
  );
});

test("(security) a refused queued message leaves the session title unchanged", async (t) => {
  const fixture = await workbenchFixture(t, [untilAbort(ANSWER)]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  for (let count = 0; count < WORKBENCH_QUEUE_LIMIT; count++)
    await queuedId(fixture, sessionId, `${FIRST_QUEUED} ${count}`);
  const { manager } = (
    fixture.workbenchService as unknown as {
      sessions: Map<
        string,
        {
          manager: {
            appendSessionInfo(name: string): void;
            getSessionName(): string | undefined;
          };
        }
      >;
    }
  ).sessions.get(sessionId)!;
  manager.appendSessionInfo("");
  assert.equal(manager.getSessionName(), undefined);
  failed(
    await message(fixture, sessionId, SECOND_QUEUED),
    HttpStatus.Conflict,
    WorkbenchErrorCode.QueueFull,
  );
  assert.equal(manager.getSessionName(), undefined);
});

test("(security) a configure during a run answers 409 run_active", async (t) => {
  const fixture = await workbenchFixture(t, [untilAbort(ANSWER)]);
  const session = await createSession(fixture);
  completed(await message(fixture, session.id, QUESTION));
  failed(
    await fixture.workbench["session.configure"](
      {
        params: { session_id: session.id },
        query: {},
        body: session.configuration,
      },
      fixture.options,
    ),
    HttpStatus.Conflict,
    WorkbenchErrorCode.RunActive,
  );
});

test("(invariant guard) a failed launch of a drained item sets the error, the next item runs and the error stays until the next run starts", async (t) => {
  const first = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(t, [
    first.step,
    fauxAssistantMessage(SECOND_ANSWER),
    fauxAssistantMessage(THIRD_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await queuedId(fixture, sessionId, FIRST_QUEUED);
  await queuedId(fixture, sessionId, SECOND_QUEUED);
  const service = fixture.workbenchService as unknown as {
    resolve(): unknown;
  };
  t.mock.method(
    service,
    "resolve",
    () => {
      throw new Error(LAUNCH_FAILURE);
    },
    { times: SINGLE },
  );
  first.gate.resolve();
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(texts(entries, "user"), [QUESTION, SECOND_QUEUED]);
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.error_message,
    LAUNCH_FAILURE,
  );
  completed(await message(fixture, sessionId, FIRST_QUEUED));
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.error_message,
    null,
  );
  await untilIdle(fixture, sessionId, t.signal);
});

test("(security) each drained run uses the requester of its own item", async (t) => {
  const first = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(t, [
    first.step,
    fauxAssistantMessage(SECOND_ANSWER),
    fauxAssistantMessage(THIRD_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  const authorize = t.mock.method(fixture.workbenchService, "authorize");
  completed(await message(fixture, sessionId, QUESTION));
  await queueMessage(fixture, sessionId, FIRST_QUEUED, {
    identity: SECOND_HUMAN,
  });
  await queueMessage(fixture, sessionId, SECOND_QUEUED);
  first.gate.resolve();
  await untilIdle(fixture, sessionId, t.signal);
  const requesters = authorize.mock.calls
    .map(({ arguments: [, requester] }) => requester.jti)
    .filter((jti, index, all) => jti !== all[index - SINGLE]);
  assert.deepEqual(requesters, [identity.jti, SECOND_HUMAN.jti, identity.jti]);
});

test("(invariant guard) the same idempotency key twice through HTTP queues one message", async (t) => {
  const fixture = await workbenchFixture(t, [untilAbort(ANSWER)]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const key = createIdempotencyKey();
  const send = async () => {
    const response = await fixture.request(
      `/api/workbench/session/${sessionId}/message`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.token}`,
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify({ text: FIRST_QUEUED }),
      },
    );
    assert.equal(response.status, HttpStatus.Accepted);
    return (await response.json()) as { queued_message_id: string };
  };
  const first = await send();
  const replay = await send();
  assert.ok(first.queued_message_id);
  assert.equal(replay.queued_message_id, first.queued_message_id);
  assert.deepEqual(
    (await snapshotOf(fixture, sessionId)).snapshot.queue.map(({ id }) => id),
    [first.queued_message_id],
  );
});

test("(invariant guard) a service stop with two queued items starts no further provider call", async (t) => {
  const fixture = await workbenchFixture(t, [
    untilAbort(ANSWER),
    fauxAssistantMessage(SECOND_ANSWER),
    fauxAssistantMessage(THIRD_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await queuedId(fixture, sessionId, FIRST_QUEUED);
  await queuedId(fixture, sessionId, SECOND_QUEUED);
  await untilProviderCall(fixture, t.signal);
  await fixture.workbenchService.stop();
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
  assert.equal(fixture.provider.calls.length, SINGLE);
});

test("(happy path) a replace during a run clears the queue, aborts the provider and runs the replace text next", async (t) => {
  const signals: (AbortSignal | undefined)[] = [];
  const fixture = await workbenchFixture(t, [
    (_context, options) => {
      signals.push(options?.signal);
      return untilAbort(ANSWER)(_context, options);
    },
    fauxAssistantMessage(SECOND_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilProviderCall(fixture, t.signal);
  const firstId = await queuedId(fixture, sessionId, FIRST_QUEUED);
  const secondId = await queuedId(fixture, sessionId, SECOND_QUEUED);
  const replaced = completed(
    await replaceMessage(fixture, sessionId, THIRD_ANSWER),
  );
  assert.deepEqual(replaced.cleared, [
    { id: firstId, text: FIRST_QUEUED, ...UNTAGGED },
    { id: secondId, text: SECOND_QUEUED, ...UNTAGGED },
  ]);
  assert.ok(replaced.queued_message_id);
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.error_message,
    null,
  );
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.equal(signals[0]?.aborted, true);
  assert.deepEqual(texts(entries, "user"), [QUESTION, THIRD_ANSWER]);
  assert.equal(fixture.provider.calls.length, SINGLE + SINGLE);
  assert.equal(
    (await snapshotOf(fixture, sessionId)).snapshot.error_message,
    null,
  );
  assert.deepEqual((await snapshotOf(fixture, sessionId)).snapshot.queue, []);
});

test("(security) a replace during a pending approval blocks the call and never invokes the operation", async (t) => {
  const { fixture, session, nodeId } = await cardFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilApproval(fixture, sessionId, t.signal);
  completed(await replaceMessage(fixture, sessionId, FIRST_QUEUED));
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ toolName: name, isError }) => ({
      name,
      isError,
    })),
    [{ name: toolName(CRITERION_SET), isError: true }],
  );
  assert.deepEqual(texts(entries, "user"), [QUESTION, FIRST_QUEUED]);
  assert.equal(await criterionOf(fixture, nodeId), ORIGINAL_CRITERION);
});

test("(invariant guard) two replaces in a row clear the first and only the second runs", async (t) => {
  const fixture = await workbenchFixture(t, [
    untilAbort(ANSWER),
    fauxAssistantMessage(SECOND_ANSWER),
    fauxAssistantMessage(THIRD_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilProviderCall(fixture, t.signal);
  const [first, second] = await Promise.all([
    replaceMessage(fixture, sessionId, FIRST_QUEUED),
    replaceMessage(fixture, sessionId, SECOND_QUEUED),
  ]);
  const firstId = completed(first).queued_message_id;
  assert.deepEqual(completed(first).cleared, []);
  assert.deepEqual(completed(second).cleared, [
    { id: firstId, text: FIRST_QUEUED, ...UNTAGGED },
  ]);
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(texts(entries, "user"), [QUESTION, SECOND_QUEUED]);
});

test("(happy path) a stop clears the queue, answers the cleared items and starts no further provider call", async (t) => {
  const fixture = await workbenchFixture(t, [
    untilAbort(ANSWER),
    fauxAssistantMessage(SECOND_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const firstId = await queuedId(fixture, sessionId, FIRST_QUEUED);
  const secondId = await queuedId(fixture, sessionId, SECOND_QUEUED);
  await untilProviderCall(fixture, t.signal);
  const stopped = completed(await stopSession(fixture, sessionId));
  assert.deepEqual(stopped, {
    session_id: sessionId,
    run_active: false,
    cleared: [
      { id: firstId, text: FIRST_QUEUED, ...UNTAGGED },
      { id: secondId, text: SECOND_QUEUED, ...UNTAGGED },
    ],
  });
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
  assert.equal(fixture.provider.calls.length, SINGLE);
  const answer = await snapshotOf(fixture, sessionId);
  assert.equal(answer.snapshot.run_active, false);
  assert.deepEqual(answer.snapshot.queue, []);
  assert.equal(answer.snapshot.error_message, null);
});

test("(invariant guard) a stop while the first launch opens the agent starts no provider call", async (t) => {
  const state = temporaryDirectory();
  const first = await workbenchFixture(
    t,
    [fauxAssistantMessage(ANSWER)],
    state,
  );
  const session = await createSession(first);
  completed(await message(first, session.id, QUESTION));
  await untilIdle(first, session.id, t.signal);
  await first.workbenchService.stop();
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const second = await workbenchFixture(
    t,
    [fauxAssistantMessage(SECOND_ANSWER)],
    state,
    undefined,
    [AGENT],
    async () => {
      entered.resolve();
      await gate.promise;
    },
  );
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const sending = message(second, session.id, QUESTION);
  await entered.promise;
  const stopping = stopSession(second, session.id);
  await setImmediate();
  gate.resolve();
  completed(await sending);
  assert.deepEqual(completed(await stopping), {
    session_id: session.id,
    run_active: false,
    cleared: [],
  });
  assert.equal(second.provider.calls.length, NO_QUEUED_MESSAGES);
  assert.equal(
    (await snapshotOf(second, session.id)).snapshot.run_active,
    false,
  );
});

test("(invariant guard) a replace right after a drained launch stops that run before its provider call and runs the replace text next", async (t) => {
  const first = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(t, [
    first.step,
    fauxAssistantMessage(SECOND_ANSWER),
  ]);
  const session = await createSession(fixture);
  const sessionId = session.id;
  type ClaimOptions = { clearError: boolean };
  type Claimer = { claim(session: unknown, options: ClaimOptions): unknown };
  const service = fixture.workbenchService as unknown as Claimer;
  const claim = service.claim.bind(service);
  let replacing: ReturnType<typeof replaceMessage> | null = null;
  t.mock.method(service, "claim", (claimed: unknown, options: ClaimOptions) => {
    const run = claim(claimed, options);
    if (!options.clearError && !replacing)
      replacing = replaceMessage(fixture, sessionId, SECOND_QUEUED);
    return run;
  });
  completed(await message(fixture, sessionId, QUESTION));
  await queuedId(fixture, sessionId, FIRST_QUEUED);
  first.gate.resolve();
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.ok(replacing);
  assert.deepEqual(
    completed(await (replacing as ReturnType<typeof replaceMessage>)).cleared,
    [],
  );
  assert.equal(texts(entries, "user").at(-SINGLE), SECOND_QUEUED);
  assert.equal(texts(entries, "assistant").at(-SINGLE), SECOND_ANSWER);
  assert.equal(fixture.provider.calls.length, SINGLE + SINGLE);
});

const FAKE_KEY = ["AKIA", "KANTHORDCANARY01"].join("");
const KEY_FILE = "key.txt";

function contextMarker(context: { messages: unknown[] }): string {
  const [marker] = JSON.stringify(context.messages).match(
    SESSION_MARKER_PATTERN,
  ) ?? [""];
  assert.ok(marker);
  return marker;
}

async function configureBackup(fixture: Fixture, sessionId: string) {
  completed(
    await fixture.workbench["session.configure"](
      {
        params: { session_id: sessionId },
        query: {},
        body: {
          agent_provider: BACKUP,
          model_identifier: SONNET,
          reasoning_effort: OFF,
        },
      },
      fixture.options,
    ),
  );
}

function redactionRecords(fixture: Fixture): Record<string, unknown>[] {
  return fixture.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.msg === REDACTION_LOG_MESSAGE);
}

test("a fake key of a workbench message reaches no model request, and its marker restores into write after configure", async (t) => {
  const path = join(temporary(t), KEY_FILE);
  const fixture = await workbenchFixture(t, [
    fauxAssistantMessage(ANSWER),
    (context) => toolCall("write", { path, content: contextMarker(context) }),
    fauxAssistantMessage(ANSWER),
  ]);
  const session = await createSession(fixture);
  completed(await message(fixture, session.id, `key ${FAKE_KEY}`));
  await untilIdle(fixture, session.id, t.signal);
  await configureBackup(fixture, session.id);
  const [record] = redactionRecords(fixture);
  assert.ok(record);
  assert.equal(record.session_id, session.id);
  assert.equal(record.unkept, NO_UNKEPT);
  assert.deepEqual(record.redaction_rules, [SensitiveRule.AwsAccessKeyId]);
  completed(await message(fixture, session.id, FIRST_MESSAGE));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError }) => isError),
    [false],
  );
  assert.equal(readFileSync(path, "utf8"), FAKE_KEY);
  assert.ok(
    fixture.provider.calls.every(
      (call) =>
        !JSON.stringify(call.messages).includes(FAKE_KEY) &&
        !call.systemPrompt?.includes(FAKE_KEY),
    ),
  );
});

test("a credential marker from before configure to another credential blocks after it", async (t) => {
  const path = join(temporary(t), KEY_FILE);
  const fixture = await workbenchFixture(t, [
    fauxAssistantMessage(ANSWER),
    (context) => toolCall("write", { path, content: contextMarker(context) }),
    fauxAssistantMessage(ANSWER),
  ]);
  const session = await createSession(fixture);
  completed(await message(fixture, session.id, `key ${PRIMARY_KEY}`));
  await untilIdle(fixture, session.id, t.signal);
  await configureBackup(fixture, session.id);
  completed(await message(fixture, session.id, FIRST_MESSAGE));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(toolResults(entries), [
    { toolName: "write", isError: true, text: RestoreReason.Credential },
  ]);
  assert.ok(
    fixture.provider.calls.every(
      (call) => !JSON.stringify(call.messages).includes(PRIMARY_KEY),
    ),
  );
});

async function blockedNode(fixture: Fixture): Promise<string> {
  const nodeId = await createNode(fixture);
  const [project] = completed(
    await fixture.projects.list(
      { params: {}, query: {}, body: null } as never,
      fixture.options,
    ),
  ).items;
  for (const operation of [
    fixture.missions["node.pause"],
    fixture.missions["node.block"],
  ] as unknown as ((input: unknown, options: unknown) => Promise<never>)[]) {
    const node = completed(
      await fixture.missions["node.get"](
        { params: { node_id: nodeId }, query: {}, body: null },
        fixture.options,
      ),
    );
    const mission = completed(
      await fixture.missions["get"](
        { params: { project_id: project!.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    completed(
      await operation(
        {
          params: { node_id: nodeId },
          query: {},
          body: {
            reason: "hold",
            expected_mission_version: mission.version,
            expected_state: node.state,
            expected_attempt: node.attempt,
          },
        },
        fixture.options,
      ),
    );
  }
  return nodeId;
}

async function nodeOf(fixture: Fixture, nodeId: string) {
  return completed(
    await fixture.missions["node.get"](
      { params: { node_id: nodeId }, query: {}, body: null },
      fixture.options,
    ),
  );
}

function offerInput(operationId: string, targetId: string) {
  return { operation_id: operationId, target_id: targetId };
}

function recordsOf(entries: readonly Entry[]): Entry[] {
  return entries.filter(
    (entry) => entry.type === CustomType && entry.customType === RECORD_ENTRY,
  );
}

async function sessionEntries(fixture: Fixture, sessionId: string) {
  return completed(
    await fixture.workbench["session.get"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  ).entries as Entry[];
}

function toolCallIds(entries: readonly Entry[]): string[] {
  return entries
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message as { role: string; toolCallId?: string })
    .filter((message) => message.role === TOOL_RESULT)
    .map((message) => message.toolCallId!);
}

async function offerFixture(t: TestContext, script: FauxResponseStep[]) {
  const fixture = await workbenchFixture(t, script, undefined, undefined, [
    OPS,
    AGENT,
    REVIEW_AGENT,
  ]);
  const session = await createSession(fixture, undefined, OPS);
  return { fixture, session };
}

test("(happy path) offer_action records the server read of a Blocked node and of a paused project and runs no act", async (t) => {
  const target = { nodeId: "", projectId: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    fauxAssistantMessage(ANSWER),
    () => toolCall(OFFER_ACTION, offerInput(PROJECT_RESUME, target.projectId)),
    fauxAssistantMessage(ANSWER),
  ]);
  target.nodeId = await blockedNode(fixture);
  const [project] = completed(
    await fixture.projects.list(
      { params: {}, query: {}, body: null } as never,
      fixture.options,
    ),
  ).items;
  target.projectId = project!.id;
  completed(
    await fixture.projects.pause(
      resumeInput(target.projectId) as never,
      fixture.options,
    ),
  );
  const before = await nodeOf(fixture, target.nodeId);
  assert.equal(before.state, NodeState.Blocked);
  completed(await message(fixture, session.id, QUESTION));
  const first = await untilIdle(fixture, session.id, t.signal);
  const [offered] = recordsOf(first);
  assert.equal(recordsOf(first).length, SINGLE);
  assert.deepEqual(offered!.data, {
    kind: "action_offer",
    tool_call_id: toolCallIds(first)[0],
    operation_id: NODE_DISCARD,
    target_id: target.nodeId,
    seen: {
      name: before.content.name,
      state: NodeState.Blocked,
      attempt: before.attempt,
    },
  });
  assert.equal((await nodeOf(fixture, target.nodeId)).state, NodeState.Blocked);
  assert.equal(
    completed(
      await fixture.workbench["session.events"](
        {
          params: { session_id: session.id },
          query: {},
          body: null,
        },
        fixture.options,
      ),
    ).snapshot.pending_approval,
    null,
  );
  completed(await message(fixture, session.id, QUESTION));
  const second = await untilIdle(
    fixture,
    session.id,
    t.signal,
    first.at(-1)!.id as string,
  );
  assert.equal(recordsOf(second).length, SINGLE);
  assert.deepEqual(recordsOf(second)[0]!.data, {
    kind: "action_offer",
    tool_call_id: toolCallIds(second)[0],
    operation_id: PROJECT_RESUME,
    target_id: target.projectId,
    seen: { name: project!.name, paused: true },
  });
  assert.notEqual(await pausedAt(fixture, target.projectId), NO_PAUSE);
});

test("(happy path) offer_action with mission.node.resume on a paused node records the node name", async (t) => {
  const target = { nodeId: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(NODE_RESUME, target.nodeId)),
    fauxAssistantMessage(ANSWER),
  ]);
  target.nodeId = await createNode(fixture);
  const [project] = completed(
    await fixture.projects.list(
      { params: {}, query: {}, body: null } as never,
      fixture.options,
    ),
  ).items;
  const node = await nodeOf(fixture, target.nodeId);
  const mission = completed(
    await fixture.missions["get"](
      { params: { project_id: project!.id }, query: {}, body: null },
      fixture.options,
    ),
  );
  completed(
    await (
      fixture.missions["node.pause"] as unknown as (
        input: unknown,
        options: unknown,
      ) => Promise<never>
    )(
      {
        params: { node_id: target.nodeId },
        query: {},
        body: {
          reason: "hold",
          expected_mission_version: mission.version,
          expected_state: node.state,
          expected_attempt: node.attempt,
        },
      },
      fixture.options,
    ),
  );
  const paused = await nodeOf(fixture, target.nodeId);
  assert.equal(paused.state, NodeState.Paused);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(recordsOf(entries)[0]!.data, {
    kind: "action_offer",
    tool_call_id: toolCallIds(entries)[0],
    operation_id: NODE_RESUME,
    target_id: target.nodeId,
    seen: {
      name: paused.content.name,
      state: NodeState.Paused,
      attempt: paused.attempt,
    },
  });
});

test("(security) offer_action refuses an operation outside the action card list and records nothing", async (t) => {
  const { fixture, session } = await offerFixture(t, [
    toolCall(
      OFFER_ACTION,
      offerInput("workbench.session.approve", UNKNOWN_NODE),
    ),
    toolCall(OFFER_ACTION, offerInput("toString", UNKNOWN_NODE)),
    fauxAssistantMessage(ANSWER),
  ]);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(entries);
  assert.equal(results.length, TWO_RESULTS);
  for (const result of results) {
    assert.equal(result.isError, true);
    assert.ok(
      result.text.startsWith("workbench.action.operation_refused:"),
      result.text,
    );
  }
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) offer_action refuses a target of the wrong kind or an unknown node and records nothing", async (t) => {
  const { fixture, session } = await offerFixture(t, [
    toolCall(
      OFFER_ACTION,
      offerInput(NODE_DISCARD, "project_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
    ),
    toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, UNKNOWN_NODE)),
    fauxAssistantMessage(ANSWER),
  ]);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(entries);
  assert.equal(results.length, TWO_RESULTS);
  assert.ok(
    results[0]!.text.startsWith("workbench.action.target_invalid:"),
    results[0]!.text,
  );
  assert.ok(
    results[1]!.text.startsWith(`${MissionErrorCode.NodeNotFound}:`),
    results[1]!.text,
  );
  assert.ok(results.every(({ isError }) => isError));
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) a second offer_action in one run gives offer_limit and the next run offers again", async (t) => {
  const target = { nodeId: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    fauxAssistantMessage(ANSWER),
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    fauxAssistantMessage(ANSWER),
  ]);
  target.nodeId = await blockedNode(fixture);
  completed(await message(fixture, session.id, QUESTION));
  const first = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(first);
  assert.deepEqual(
    results.map(({ isError }) => isError),
    [false, true],
  );
  assert.ok(
    results[1]!.text.startsWith("workbench.action.offer_limit:"),
    results[1]!.text,
  );
  assert.equal(recordsOf(first).length, SINGLE);
  completed(await message(fixture, session.id, QUESTION));
  const second = await untilIdle(
    fixture,
    session.id,
    t.signal,
    first.at(-1)!.id as string,
  );
  assert.deepEqual(
    toolResults(second).map(({ isError }) => isError),
    [false],
  );
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    SINGLE + SINGLE,
  );
});

test("(invariant guard) the action_offer record leaves buildSessionContext unchanged", async (t) => {
  const target = { nodeId: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    fauxAssistantMessage(ANSWER),
  ]);
  target.nodeId = await blockedNode(fixture);
  completed(await message(fixture, session.id, QUESTION));
  await untilIdle(fixture, session.id, t.signal);
  const entries = await sessionEntries(fixture, session.id);
  const [record] = recordsOf(entries);
  assert.ok(record);
  const without = entries
    .filter((entry) => entry !== record)
    .map((entry) =>
      entry.parentId === record.id
        ? { ...entry, parentId: record.parentId }
        : entry,
    );
  const { buildSessionContext } = await loadPi();
  assert.deepEqual(
    buildSessionContext(entries as never),
    buildSessionContext(without as never),
  );
});

const CUSTOM_MESSAGE = "custom_message";
const NO_ERROR_CODE = null;
const DISCARD_REASON = "owner decision";
const TWO_PROVIDER_CALLS = 2;
const RESULT_TEXT_DONE = (operation: string, target: string) =>
  `The owner ran ${operation} on ${target}. Result: done.`;

function reportAction(
  fixture: Fixture,
  sessionId: string,
  toolCallId: string,
  body: { outcome: string; error_code: string | null },
) {
  return fixture.workbench["session.action.report"](
    {
      params: { session_id: sessionId, tool_call_id: toolCallId },
      query: {},
      body,
    } as never,
    fixture.options,
  );
}

function resultsOf(entries: readonly Entry[]): Entry[] {
  return entries.filter(
    (entry) =>
      entry.type === CUSTOM_MESSAGE &&
      entry.customType === WORKBENCH_ACTION_RESULT_ENTRY,
  );
}

async function offeredProject(t: TestContext, stateDirectory?: string) {
  const target = { projectId: "" };
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        toolCall(OFFER_ACTION, offerInput(PROJECT_RESUME, target.projectId)),
      fauxAssistantMessage(ANSWER),
    ],
    stateDirectory,
    undefined,
    [OPS],
  );
  target.projectId = await pausedProject(fixture);
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  return {
    fixture,
    session,
    entries,
    projectId: target.projectId,
    toolCallId: toolCallIds(entries)[0]!,
  };
}

test("(happy path) action.report done appends one hidden action_result message and the next run reads its text", async (t) => {
  const { fixture, session, projectId, toolCallId } = await offeredProject(t);
  assert.deepEqual(
    completed(
      await reportAction(fixture, session.id, toolCallId, {
        outcome: ActionOutcome.Done,
        error_code: NO_ERROR_CODE,
      }),
    ),
    {
      session_id: session.id,
      tool_call_id: toolCallId,
      outcome: ActionOutcome.Done,
    },
  );
  const stored = resultsOf(await sessionEntries(fixture, session.id));
  assert.equal(stored.length, SINGLE);
  assert.equal(stored[0]!.display, false);
  assert.deepEqual(stored[0]!.details, {
    tool_call_id: toolCallId,
    operation_id: PROJECT_RESUME,
    target_id: projectId,
    outcome: ActionOutcome.Done,
    error_code: NO_ERROR_CODE,
  });
  const text = RESULT_TEXT_DONE(PROJECT_RESUME, projectId);
  assert.equal(stored[0]!.content, text);
  fixture.provider.calls.length = 0;
  completed(await message(fixture, session.id, QUESTION));
  await untilIdle(fixture, session.id, t.signal);
  assert.ok(JSON.stringify(fixture.provider.calls[0]!.messages).includes(text));
});

test("(invariant guard) a done result settles the card, and a failed result does not", async (t) => {
  const { fixture, session, projectId, toolCallId } = await offeredProject(t);
  const failure = {
    outcome: ActionOutcome.Failed,
    error_code: "project.not_found",
  };
  const done = { outcome: ActionOutcome.Done, error_code: NO_ERROR_CODE };
  completed(await reportAction(fixture, session.id, toolCallId, failure));
  completed(
    await reportAction(fixture, session.id, toolCallId, {
      outcome: ActionOutcome.Failed,
      error_code: NO_ERROR_CODE,
    }),
  );
  completed(await reportAction(fixture, session.id, toolCallId, done));
  for (const body of [done, failure])
    failed(
      await reportAction(fixture, session.id, toolCallId, body),
      HttpStatus.Conflict,
      WorkbenchErrorCode.ActionSettled,
    );
  const stored = resultsOf(await sessionEntries(fixture, session.id));
  assert.deepEqual(
    stored.map((entry) => entry.content),
    [
      `The owner ran ${PROJECT_RESUME} on ${projectId}. Result: failed, project.not_found.`,
      `The owner ran ${PROJECT_RESUME} on ${projectId}. Result: failed.`,
      RESULT_TEXT_DONE(PROJECT_RESUME, projectId),
    ],
  );
});

test("(security) action.report answers 404 for an unknown tool call and 400 for a done with an error code", async (t) => {
  const { fixture, session, toolCallId } = await offeredProject(t);
  failed(
    await reportAction(fixture, session.id, "absent", {
      outcome: ActionOutcome.Done,
      error_code: NO_ERROR_CODE,
    }),
    HttpStatus.NotFound,
    WorkbenchErrorCode.ActionNotFound,
  );
  failed(
    await reportAction(fixture, session.id, toolCallId, {
      outcome: ActionOutcome.Done,
      error_code: "project.not_found",
    }),
    HttpStatus.BadRequest,
    "gateway.request.validation_failed",
  );
  assert.equal(
    resultsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(invariant guard) action.report during an active run lands after the turn and keeps each tool call next to its result", async (t) => {
  const target = { projectId: "" };
  const held = heldAnswer(ANSWER);
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        toolCall(OFFER_ACTION, offerInput(PROJECT_RESUME, target.projectId)),
      held.step,
    ],
    undefined,
    undefined,
    [OPS],
  );
  target.projectId = await pausedProject(fixture);
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, QUESTION));
  while (fixture.provider.calls.length < TWO_PROVIDER_CALLS) {
    t.signal.throwIfAborted();
    await setImmediate();
  }
  const [offered] = recordsOf(await eventEntries(fixture, session.id));
  const toolCallId = (offered!.data as { tool_call_id: string }).tool_call_id;
  const done = { outcome: ActionOutcome.Done, error_code: NO_ERROR_CODE };
  completed(await reportAction(fixture, session.id, toolCallId, done));
  for (const body of [
    done,
    { outcome: ActionOutcome.Failed, error_code: NO_ERROR_CODE },
  ])
    failed(
      await reportAction(fixture, session.id, toolCallId, body),
      HttpStatus.Conflict,
      WorkbenchErrorCode.ActionSettled,
    );
  held.gate.resolve();
  await untilIdle(fixture, session.id, t.signal);
  const entries = await sessionEntries(fixture, session.id);
  const types = entries.map((entry) =>
    entry.type === MESSAGE_ENTRY
      ? (entry.message as { role: string }).role
      : entry.type === CUSTOM_MESSAGE
        ? CUSTOM_MESSAGE
        : (entry.type as string),
  );
  assert.deepEqual(types.slice(-5), [
    "assistant",
    CustomType,
    TOOL_RESULT,
    "assistant",
    CUSTOM_MESSAGE,
  ]);
  assert.equal(resultsOf(entries).length, SINGLE);
  const { buildSessionContext } = await loadPi();
  const roles = buildSessionContext(entries as never).messages.map(
    (entry) => entry.role,
  );
  assert.deepEqual(roles.slice(-4), [
    "assistant",
    TOOL_RESULT,
    "assistant",
    "custom",
  ]);
});

test("(happy path) action.report after a restart appends through the session manager and the next run reads it", async (t) => {
  const state = temporaryDirectory();
  const first = await offeredProject(t, state);
  assert.equal(
    (await first.fixture.workbenchService.stop()) ?? undefined,
    undefined,
  );
  const second = await workbenchFixture(
    t,
    [fauxAssistantMessage(ANSWER)],
    state,
    undefined,
    [OPS],
  );
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  completed(
    await reportAction(second, first.session.id, first.toolCallId, {
      outcome: ActionOutcome.Done,
      error_code: NO_ERROR_CODE,
    }),
  );
  const text = RESULT_TEXT_DONE(PROJECT_RESUME, first.projectId);
  assert.equal(
    resultsOf(await sessionEntries(second, first.session.id)).length,
    SINGLE,
  );
  completed(await message(second, first.session.id, QUESTION));
  await untilIdle(second, first.session.id, t.signal);
  assert.ok(JSON.stringify(second.provider.calls[0]!.messages).includes(text));
});

test("(security) a direct human discard after a card is attributed to the owner account, then action.report done succeeds", async (t) => {
  const target = { nodeId: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(NODE_DISCARD, target.nodeId)),
    fauxAssistantMessage(ANSWER),
  ]);
  target.nodeId = await blockedNode(fixture);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const node = await nodeOf(fixture, target.nodeId);
  const mission = completed(
    await fixture.missions.get(
      {
        params: { project_id: await firstProjectId(fixture) },
        query: {},
        body: null,
      },
      fixture.options,
    ),
  );
  const discarded = completed(
    await fixture.missions["node.discard"](
      {
        params: { node_id: target.nodeId },
        query: {},
        body: {
          reason: DISCARD_REASON,
          expected_mission_version: mission.version,
          expected_state: node.state,
          expected_attempt: node.attempt,
        },
      },
      fixture.options,
    ),
  );
  assert.equal(discarded.node.state, NodeState.Discarded);
  const stored = completed(
    await fixture.missions["assessment.list"](
      {
        params: { node_id: target.nodeId },
        query: {},
        body: null,
      } as never,
      fixture.options,
    ),
  ).items.find((assessment) => assessment.rationale === DISCARD_REASON);
  assert.deepEqual(stored?.actor, {
    kind: "human",
    account: identity.accountId,
    name: identity.name,
  });
  completed(
    await reportAction(fixture, session.id, toolCallIds(entries)[0]!, {
      outcome: ActionOutcome.Done,
      error_code: NO_ERROR_CODE,
    }),
  );
});

async function firstProjectId(fixture: Fixture): Promise<string> {
  const [project] = completed(
    await fixture.projects.list(
      { params: {}, query: {}, body: null } as never,
      fixture.options,
    ),
  ).items;
  return project!.id;
}

async function eventEntries(fixture: Fixture, sessionId: string) {
  return completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  ).entries as Entry[];
}

const EVIDENCE_READ = "evidence_read";
const OBJECT_KIND = "object";
const SESSION_FILE_SUFFIX = ".jsonl";
const DOWNLOAD_OPERATION = "mission.evidence.asset.content.download";
const ALPHA_TEXT = "alpha evidence text";
const BETA_TEXT = "beta evidence text";
const GAMMA_TEXT = "gamma evidence text";
const OBJECT_TEXT = "object evidence text";
const LARGE_OBJECT_BYTES = 1024 ** 2;
const EVIDENCE_TEXT_CAP = 65536;
const SIGNED_QUERY_MARKER = "X-Amz-";
const FIRST_ATTEMPT_NUMBER = 1;
const STORAGE_CLOSE_POLLS = 100;
const STORAGE_CLOSE_POLL_MS = 20;
const MASTER_KEY_BYTES = 32;

interface EvidenceTarget {
  nodes: SeededNode[];
}

interface EvidenceSetup {
  nodes: Parameters<typeof seedEvidence>[2];
  storage?: boolean;
  stateDirectory?: string;
  persistence?: Persistence;
  agentName?: string;
}

function evidenceCall(target: EvidenceTarget, node: number, asset: number) {
  return () => {
    const found = target.nodes[node]!.produced[asset]!;
    return toolCall(EVIDENCE_READ, {
      evidence_id: found.evidenceId,
      asset_id: found.assetId,
    });
  };
}

async function evidenceFixture(
  t: TestContext,
  script: FauxResponseStep[],
  target: EvidenceTarget,
  setup: EvidenceSetup,
) {
  const agentName = setup.agentName ?? REVIEW_AGENT;
  const fixture = await workbenchFixture(
    t,
    script,
    setup.stateDirectory,
    undefined,
    [agentName],
    undefined,
    setup.persistence,
  );
  const s3 = await fakeS3(t);
  target.nodes = await seedEvidence(t, fixture, setup.nodes, {
    ...(setup.storage ? { s3 } : {}),
  });
  const session = await createSession(fixture, undefined, agentName);
  return { fixture, session, s3 };
}

test("(happy path) evidence_read shows one card for a node, runs the next asset of that node with none and shows a new card for another node", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      evidenceCall(target, 0, 0),
      evidenceCall(target, 0, 1),
      evidenceCall(target, 1, 0),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    {
      nodes: [
        { produced: [ALPHA_TEXT, BETA_TEXT] },
        { produced: [GAMMA_TEXT] },
      ],
    },
  );
  completed(await message(fixture, session.id, QUESTION));
  const first = await untilApproval(fixture, session.id, t.signal);
  const [nodeA, nodeB] = target.nodes as [SeededNode, SeededNode];
  assert.equal(first.operation_id, DOWNLOAD_OPERATION);
  assert.deepEqual(first.input, {
    node_id: nodeA.nodeId,
    attempt: FIRST_ATTEMPT_NUMBER,
    evidence_id: nodeA.produced[0]!.evidenceId,
    asset_id: nodeA.produced[0]!.assetId,
    kind: "produced",
  });
  completed(await decide(fixture, session.id, first.tool_call_id, true));
  const second = await untilApproval(fixture, session.id, t.signal);
  assert.equal(second.input.node_id, nodeB.nodeId);
  assert.equal(second.input.asset_id, nodeB.produced[0]!.assetId);
  completed(await decide(fixture, session.id, second.tool_call_id, true));
  const results = toolResults(await untilIdle(fixture, session.id, t.signal));
  assert.deepEqual(
    results.map(({ isError }) => isError),
    [false, false, false],
  );
  for (const [index, text] of [ALPHA_TEXT, BETA_TEXT, GAMMA_TEXT].entries())
    assert.ok(results[index]!.text.includes(text), text);
});

test("(security) a rejected evidence card grants nothing, an expired card grants nothing and the next call shows a card again", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      evidenceCall(target, 0, 0),
      evidenceCall(target, 0, 1),
      evidenceCall(target, 0, 0),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [ALPHA_TEXT, BETA_TEXT] }] },
  );
  enableTimers(t);
  completed(await message(fixture, session.id, QUESTION));
  const rejected = await untilApproval(fixture, session.id, t.signal);
  completed(await decide(fixture, session.id, rejected.tool_call_id, false));
  const expiring = await untilApproval(fixture, session.id, t.signal);
  assert.equal(expiring.input.node_id, target.nodes[0]!.nodeId);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError, text }) => ({ isError, text })),
    [
      { isError: true, text: WORKBENCH_REJECTION_REASON },
      { isError: true, text: WORKBENCH_EXPIRY_REASON },
    ],
  );
  completed(await message(fixture, session.id, QUESTION));
  const again = await untilApproval(fixture, session.id, t.signal);
  assert.equal(again.input.node_id, target.nodes[0]!.nodeId);
  completed(await decide(fixture, session.id, again.tool_call_id, true));
  const last = await untilIdle(
    fixture,
    session.id,
    t.signal,
    entries.at(-1)!.id as string,
  );
  assert.deepEqual(
    toolResults(last).map(({ isError }) => isError),
    [false],
  );
});

test("(security, the grant lives in memory) a restart of kanthord clears the grant and the next call shows a card", async (t) => {
  const state = temporaryDirectory();
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const persistence = {
    path: join(temporary(t), "operational.db"),
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    resumed: false,
  };
  const target: EvidenceTarget = { nodes: [] };
  let sessionId = "";
  await t.test("grant a node and stop", async (step) => {
    const { fixture: first, session } = await evidenceFixture(
      step,
      [evidenceCall(target, 0, 0), fauxAssistantMessage(ANSWER)],
      target,
      {
        nodes: [{ produced: [ALPHA_TEXT, BETA_TEXT] }],
        stateDirectory: state,
        persistence,
      },
    );
    sessionId = session.id;
    completed(await message(first, session.id, QUESTION));
    const granted = await untilApproval(first, session.id, step.signal);
    completed(await decide(first, session.id, granted.tool_call_id, true));
    await untilIdle(first, session.id, step.signal);
  });
  const second = await workbenchFixture(
    t,
    [evidenceCall(target, 0, 1), fauxAssistantMessage(ANSWER)],
    state,
    undefined,
    [REVIEW_AGENT],
    undefined,
    { ...persistence, resumed: true },
  );
  completed(await message(second, sessionId, QUESTION));
  const pending = await untilApproval(second, sessionId, t.signal);
  assert.equal(pending.operation_id, DOWNLOAD_OPERATION);
  assert.equal(pending.input.node_id, target.nodes[0]!.nodeId);
});

test("(invariant guard, race of two calls in one batch) two evidence_read calls on one node in one batch show one card and both succeed", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      () =>
        fauxAssistantMessage(
          target.nodes[0]!.produced.map(({ evidenceId, assetId }) =>
            fauxToolCall(EVIDENCE_READ, {
              evidence_id: evidenceId,
              asset_id: assetId,
            }),
          ),
          { stopReason: TOOL_USE },
        ),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [ALPHA_TEXT, BETA_TEXT] }] },
  );
  completed(await message(fixture, session.id, QUESTION));
  const pending = await untilApproval(fixture, session.id, t.signal);
  completed(await decide(fixture, session.id, pending.tool_call_id, true));
  const results = toolResults(await untilIdle(fixture, session.id, t.signal));
  assert.deepEqual(
    results.map(({ isError }) => isError),
    [false, false],
  );
});

test("(security) an asset outside the evidence gives asset_mismatch and no pending card", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      () =>
        toolCall(EVIDENCE_READ, {
          evidence_id: target.nodes[0]!.produced[0]!.evidenceId,
          asset_id: target.nodes[1]!.produced[0]!.assetId,
        }),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [ALPHA_TEXT] }, { produced: [GAMMA_TEXT] }] },
  );
  completed(await message(fixture, session.id, QUESTION));
  const results = toolResults(await untilIdle(fixture, session.id, t.signal));
  assert.equal(results.length, SINGLE);
  assert.equal(results[0]!.isError, true);
  assert.ok(results[0]!.text.startsWith("workbench.evidence.asset_mismatch: "));
  assert.equal(
    (await snapshotOf(fixture, session.id)).snapshot.pending_approval,
    null,
  );
});

test("(security, redaction) an object read leaves no signed URL and no storage host in the result, the details or the session file", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session, s3 } = await evidenceFixture(
    t,
    [
      () =>
        toolCall(EVIDENCE_READ, {
          evidence_id: target.nodes[0]!.object!.evidenceId,
          asset_id: target.nodes[0]!.object!.assetId,
        }),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [], object: OBJECT_TEXT }], storage: true },
  );
  completed(await message(fixture, session.id, QUESTION));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.input.kind, OBJECT_KIND);
  completed(await decide(fixture, session.id, pending.tool_call_id, true));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const [result] = toolResults(entries);
  assert.equal(result!.isError, false);
  assert.ok(result!.text.includes(OBJECT_TEXT));
  const raw = readdirSync(fixture.stateDirectory, {
    recursive: true,
    encoding: "utf8",
  })
    .filter((name) => name.endsWith(SESSION_FILE_SUFFIX))
    .map((name) => readFileSync(join(fixture.stateDirectory, name), "utf8"))
    .join("\n");
  assert.ok(raw.length);
  const host = new URL(s3.endpoint).host;
  for (const text of [JSON.stringify(entries), raw]) {
    assert.ok(!text.includes(SIGNED_QUERY_MARKER));
    assert.ok(!text.includes(host));
  }
});

test("(security, argument guard) evidence_read cancels the body at its cap on a large object and the storage sees the connection close", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session, s3 } = await evidenceFixture(
    t,
    [
      () =>
        toolCall(EVIDENCE_READ, {
          evidence_id: target.nodes[0]!.object!.evidenceId,
          asset_id: target.nodes[0]!.object!.assetId,
        }),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    {
      nodes: [{ produced: [], object: "x".repeat(LARGE_OBJECT_BYTES) }],
      storage: true,
    },
  );
  s3.overrunNext();
  completed(await message(fixture, session.id, QUESTION));
  const pending = await untilApproval(fixture, session.id, t.signal);
  completed(await decide(fixture, session.id, pending.tool_call_id, true));
  const [result] = toolResults(await untilIdle(fixture, session.id, t.signal));
  assert.equal(result!.isError, false);
  const block1 = JSON.parse(
    result!.text.slice(NO_TOOLS, result!.text.indexOf("}") + SINGLE),
  ) as {
    length: number;
    truncated: boolean;
  };
  assert.equal(block1.length, EVIDENCE_TEXT_CAP);
  assert.equal(block1.truncated, true);
  for (let poll = 0; poll < STORAGE_CLOSE_POLLS && !s3.closed.length; poll++)
    await new Promise((resolve) => setTimeout(resolve, STORAGE_CLOSE_POLL_MS));
  assert.equal(s3.closed.length, SINGLE);
});

test("(happy path) the provider receives evidence_read for swe@1 and re@1 and none for ops@1, and agent.get lists it as a card workbench tool", async (t) => {
  const agents = [OPS, AGENT, REVIEW_AGENT];
  const fixture = await workbenchFixture(
    t,
    agents.map(() => fauxAssistantMessage(ANSWER)),
    undefined,
    undefined,
    agents,
  );
  for (const [index, agentName] of agents.entries()) {
    const session = await createSession(fixture, undefined, agentName);
    completed(await message(fixture, session.id, QUESTION));
    await untilIdle(fixture, session.id, t.signal);
    assert.equal(
      fixture.provider.tools[index]!.includes(EVIDENCE_READ),
      agentName !== OPS,
      agentName,
    );
  }
  const { tools } = completed(
    await fixture.agent.get(
      { params: { agent_name: REVIEW_AGENT }, query: {}, body: null },
      fixture.options,
    ),
  );
  const listed = tools.find(({ name }) => name === EVIDENCE_READ);
  assert.equal(listed?.source, ToolSource.Workbench);
  assert.equal(listed?.guard_class, GuardClass.Card);
});

const CREDENTIAL_ROTATE = "llm.credential.rotate";
const BINDING_SET_WRITE = "project.bindingSet.write";
const ENABLEMENT_PUT = "agent.enablement.put";
const SETUP_CREDENTIAL = "anthropic-main";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const THREE_OFFERS = 3;
const SETUP_SEEN_KEYS = [
  "kind",
  "operation_id",
  "seen",
  "target_id",
  "tool_call_id",
];

async function setupFixture(t: TestContext, operationId: string) {
  const target = { id: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(operationId, target.id)),
    fauxAssistantMessage(ANSWER),
  ]);
  return { fixture, session, target };
}

async function offerOnce(
  t: TestContext,
  fixture: Fixture,
  sessionId: string,
): Promise<Entry[]> {
  completed(await message(fixture, sessionId, QUESTION));
  return untilIdle(fixture, sessionId, t.signal);
}

async function rotatedCredential(fixture: Fixture): Promise<string> {
  const llm = directClient(llmOperations, fixture.invocation);
  completed(
    await llm.create(
      {
        params: {},
        query: {},
        body: {
          name: SETUP_CREDENTIAL,
          platform: ANTHROPIC,
          metadata: null,
          secret: { key: "setup-first-key" },
        },
      },
      fixture.options,
    ),
  );
  completed(
    await llm.rotate(
      {
        params: { credential_name: SETUP_CREDENTIAL },
        query: {},
        body: { expected_revision: FIRST_REVISION, secret: { key: "second" } },
      } as never,
      fixture.options,
    ),
  );
  return SETUP_CREDENTIAL;
}

async function createdProject(fixture: Fixture): Promise<string> {
  return completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: PROJECT_NAME } },
      fixture.options,
    ),
  ).id;
}

async function bindingSetVersion(
  fixture: Fixture,
  projectId: string,
): Promise<number> {
  return completed(
    await fixture.projects["bindingSet.get"](
      { params: { project_id: projectId }, query: {}, body: null } as never,
      fixture.options,
    ),
  ).version;
}

async function enablementRevision(
  fixture: Fixture,
  agentName: string,
): Promise<number> {
  return completed(
    await fixture.agent["enablement.get"](
      { params: { agent_name: agentName }, query: {}, body: null } as never,
      fixture.options,
    ),
  ).revision;
}

function assertSetupRecord(
  entries: readonly Entry[],
  operationId: string,
  targetId: string,
  seen: object,
): void {
  const [record] = recordsOf(entries);
  assert.equal(recordsOf(entries).length, SINGLE);
  assert.deepEqual(record!.data, {
    kind: "action_offer",
    tool_call_id: toolCallIds(entries)[0],
    operation_id: operationId,
    target_id: targetId,
    seen,
  });
  assert.deepEqual(Object.keys(record!.data as object).sort(), SETUP_SEEN_KEYS);
}

test("(happy path) offer_action on a rotated credential records its newest live revision", async (t) => {
  const { fixture, session, target } = await setupFixture(t, CREDENTIAL_ROTATE);
  target.id = await rotatedCredential(fixture);
  const entries = await offerOnce(t, fixture, session.id);
  assertSetupRecord(entries, CREDENTIAL_ROTATE, SETUP_CREDENTIAL, {
    revision: SECOND_REVISION,
  });
});

test("(happy path) offer_action on an enabled agent records the revision of its enablement", async (t) => {
  const { fixture, session, target } = await setupFixture(t, ENABLEMENT_PUT);
  target.id = OPS;
  const entries = await offerOnce(t, fixture, session.id);
  assertSetupRecord(entries, ENABLEMENT_PUT, OPS, {
    revision: await enablementRevision(fixture, OPS),
  });
});

test("(happy path) offer_action on a project records the version of its binding set", async (t) => {
  const { fixture, session, target } = await setupFixture(t, BINDING_SET_WRITE);
  target.id = await createdProject(fixture);
  const entries = await offerOnce(t, fixture, session.id);
  assertSetupRecord(entries, BINDING_SET_WRITE, target.id, {
    version: await bindingSetVersion(fixture, target.id),
  });
});

test("(security) offer_action on an absent credential gives credential.credential.not_found and records nothing", async (t) => {
  const { fixture, session, target } = await setupFixture(t, CREDENTIAL_ROTATE);
  target.id = "absent-credential";
  const entries = await offerOnce(t, fixture, session.id);
  const [result] = toolResults(entries);
  assert.equal(result!.isError, true);
  assert.ok(
    result!.text.startsWith("credential.credential.not_found:"),
    result!.text,
  );
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) offer_action on an archived credential gives workbench.action.target_refused and records nothing", async (t) => {
  const { fixture, session, target } = await setupFixture(t, CREDENTIAL_ROTATE);
  target.id = await rotatedCredential(fixture);
  completed(
    await directClient(llmOperations, fixture.invocation).archive(
      {
        params: { credential_name: target.id },
        query: {},
        body: null,
      } as never,
      fixture.options,
    ),
  );
  const entries = await offerOnce(t, fixture, session.id);
  const [result] = toolResults(entries);
  assert.equal(result!.isError, true);
  assert.ok(
    result!.text.startsWith("workbench.action.target_refused:"),
    result!.text,
  );
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) offer_action on an absent project gives project.project.not_found and records nothing", async (t) => {
  const { fixture, session, target } = await setupFixture(t, BINDING_SET_WRITE);
  target.id = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const entries = await offerOnce(t, fixture, session.id);
  const [result] = toolResults(entries);
  assert.equal(result!.isError, true);
  assert.ok(
    result!.text.startsWith("project.project.not_found:"),
    result!.text,
  );
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) offer_action on an absent agent enablement gives agent.enablement.not_found and records nothing", async (t) => {
  const { fixture, session, target } = await setupFixture(t, ENABLEMENT_PUT);
  target.id = "ghost@1";
  const entries = await offerOnce(t, fixture, session.id);
  const [result] = toolResults(entries);
  assert.equal(result!.isError, true);
  assert.ok(
    result!.text.startsWith("agent.enablement.not_found:"),
    result!.text,
  );
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    NO_RECORDS,
  );
});

test("(security) a setup offer runs no mutation, appends one record and creates no pending approval", async (t) => {
  const target = { operationId: "", id: "" };
  const { fixture, session } = await offerFixture(t, [
    () => toolCall(OFFER_ACTION, offerInput(target.operationId, target.id)),
    fauxAssistantMessage(ANSWER),
    () => toolCall(OFFER_ACTION, offerInput(target.operationId, target.id)),
    fauxAssistantMessage(ANSWER),
    () => toolCall(OFFER_ACTION, offerInput(target.operationId, target.id)),
    fauxAssistantMessage(ANSWER),
  ]);
  const credential = await rotatedCredential(fixture);
  const projectId = await createdProject(fixture);
  const before = {
    version: await bindingSetVersion(fixture, projectId),
    revision: await enablementRevision(fixture, OPS),
  };
  let after: string | undefined;
  for (const [operationId, id] of [
    [CREDENTIAL_ROTATE, credential],
    [BINDING_SET_WRITE, projectId],
    [ENABLEMENT_PUT, OPS],
  ] as const) {
    target.operationId = operationId;
    target.id = id;
    completed(await message(fixture, session.id, QUESTION));
    const entries = await untilIdle(fixture, session.id, t.signal, after);
    after = entries.at(-1)!.id as string;
    assert.equal(recordsOf(entries).length, SINGLE, operationId);
    assert.equal(
      completed(
        await fixture.workbench["session.events"](
          { params: { session_id: session.id }, query: {}, body: null },
          fixture.options,
        ),
      ).snapshot.pending_approval,
      null,
      operationId,
    );
  }
  assert.equal(
    recordsOf(await sessionEntries(fixture, session.id)).length,
    THREE_OFFERS,
  );
  assert.equal(await bindingSetVersion(fixture, projectId), before.version);
  assert.equal(await enablementRevision(fixture, OPS), before.revision);
  const credentials = completed(
    await directClient(llmOperations, fixture.invocation).get(
      {
        params: { credential_name: credential },
        query: {},
        body: null,
      } as never,
      fixture.options,
    ),
  );
  assert.equal(credentials.revisions.length, SECOND_REVISION);
});

const IMPORT_APPLY = missionOperations["import.apply"].id;
const PREVIEW_DIGEST = "a".repeat(64);
const IMPORT_REASON = "import the plan";

interface ImportTarget {
  missionId: string;
  version: number;
  nodeId: string;
}

function importToolInput(target: ImportTarget, body: Record<string, unknown>) {
  return {
    params: { mission_id: target.missionId },
    body: {
      mission_id: target.missionId,
      mission_version: target.version,
      reason: IMPORT_REASON,
      preview_digest: PREVIEW_DIGEST,
      ...body,
    },
  };
}

async function importTarget(fixture: Fixture): Promise<ImportTarget> {
  const nodeId = await createNode(fixture);
  const mission = completed(
    await fixture.missions.get(
      {
        params: { project_id: await firstProjectId(fixture) },
        query: {},
        body: null,
      },
      fixture.options,
    ),
  );
  return { missionId: mission.id, version: mission.version, nodeId };
}

async function importState(fixture: Fixture, target: ImportTarget) {
  const mission = completed(
    await fixture.missions.get(
      {
        params: { project_id: await firstProjectId(fixture) },
        query: {},
        body: null,
      },
      fixture.options,
    ),
  );
  const nodes = completed(
    await fixture.missions["node.list"](
      {
        params: { mission_id: target.missionId },
        query: {},
        body: null,
      } as never,
      fixture.options,
    ),
  );
  return {
    version: mission.version,
    nodeIds: nodes.items.map(({ id }) => id),
  };
}

async function importFixture(
  t: TestContext,
  bodiesOf: (target: ImportTarget) => Record<string, unknown>[],
) {
  const holder = { target: undefined as ImportTarget | undefined };
  const bodies: Record<string, unknown>[] = [];
  const fixture = await workbenchFixture(
    t,
    [
      ...[0, 1].map((index) => () => {
        assert.ok(holder.target);
        const body = bodies[index];
        assert.ok(body);
        return toolCall(
          toolName(IMPORT_APPLY),
          importToolInput(holder.target, body),
        );
      }),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [OPS, AGENT, REVIEW_AGENT],
  );
  const target = await importTarget(fixture);
  holder.target = target;
  bodies.push(...bodiesOf(target));
  const session = await createSession(fixture, undefined, OPS);
  return { fixture, session, target };
}

test("(security: refused path) an import with retirements or with markdown creates no card, runs no import and returns the guard code", async (t) => {
  const { fixture, session, target } = await importFixture(t, (node) => [
    {
      format: ImportFormat.Json,
      entries: [],
      confirmed_retirements: [node.nodeId],
    },
    {
      format: ImportFormat.Markdown,
      files: [],
      confirmed_retirements: [],
    },
  ]);
  const before = await importState(fixture, target);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const results = toolResults(entries);
  assert.equal(results.length, TWO_RESULTS);
  assert.ok(
    results[0]?.text.startsWith(WorkbenchGuardReason.HumanOnly),
    results[0]?.text ?? "",
  );
  assert.ok(
    results[1]?.text.startsWith(WorkbenchGuardReason.ImportFormat),
    results[1]?.text ?? "",
  );
  assert.ok(results.every(({ isError }) => isError));
  assert.equal(
    (await snapshotOf(fixture, session.id)).snapshot.pending_approval,
    null,
  );
  assert.deepEqual(await importState(fixture, target), before);
});

test("(security: authorization) an import with no retirement waits on the card and a rejection runs nothing", async (t) => {
  const { fixture, session, target } = await importFixture(t, () => [
    { format: ImportFormat.Json, entries: [], confirmed_retirements: [] },
    { format: ImportFormat.Json, entries: [], confirmed_retirements: [] },
  ]);
  const before = await importState(fixture, target);
  completed(await message(fixture, session.id, QUESTION));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.operation_id, IMPORT_APPLY);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  const second = await untilApproval(fixture, session.id, t.signal);
  completed(await decide(fixture, session.id, second.tool_call_id, false));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.ok(toolResults(entries).every(({ isError }) => isError));
  assert.deepEqual(await importState(fixture, target), before);
});

const AUTO_MODE_KIND = "auto_mode";

const THREE_RECORDS = 3;

async function setAutoMode(
  fixture: Fixture,
  sessionId: string,
  enabled: boolean,
) {
  return fixture.workbench["session.autoMode.set"](
    {
      params: { session_id: sessionId },
      query: {},
      body: { enabled },
    },
    fixture.options,
  );
}

async function autoModeState(fixture: Fixture, sessionId: string) {
  const answer = completed(
    await fixture.workbench["session.events"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  return {
    enabled: answer.snapshot.auto_mode,
    records: answer.entries.filter(
      (entry) =>
        (entry.data as { kind?: string } | undefined)?.kind === AUTO_MODE_KIND,
    ).length,
  };
}

test("(happy path) autoMode.set answers 200 with no active run, shows in the run snapshot, and a set to the current value appends no record", async (t) => {
  const fixture = await workbenchFixture(t);
  const session = await createSession(fixture);
  assert.deepEqual(await autoModeState(fixture, session.id), {
    enabled: true,
    records: NO_RECORDS,
  });
  assert.deepEqual(completed(await setAutoMode(fixture, session.id, true)), {
    session_id: session.id,
    enabled: true,
  });
  assert.deepEqual(completed(await setAutoMode(fixture, session.id, false)), {
    session_id: session.id,
    enabled: false,
  });
  assert.deepEqual(completed(await setAutoMode(fixture, session.id, false)), {
    session_id: session.id,
    enabled: false,
  });
  assert.deepEqual(await autoModeState(fixture, session.id), {
    enabled: false,
    records: SINGLE,
  });
});

test("(invariant guard, data loss) a new service over the same state directory opens the session with the last auto mode value", async (t) => {
  const state = temporaryDirectory();
  stopAfter(t, () => rmSync(state, { recursive: true, force: true }));
  const persistence = {
    path: join(temporary(t), "operational.db"),
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    resumed: false,
  };
  let sessionId = "";
  await t.test(
    "switch auto mode off and on and off, then stop",
    async (step) => {
      const first = await workbenchFixture(
        step,
        [fauxAssistantMessage(ANSWER)],
        state,
        undefined,
        [AGENT],
        undefined,
        persistence,
      );
      sessionId = (await createSession(first)).id;
      completed(await message(first, sessionId, QUESTION));
      await untilIdle(first, sessionId, step.signal);
      for (const enabled of [false, true, false])
        completed(await setAutoMode(first, sessionId, enabled));
    },
  );
  const second = await workbenchFixture(
    t,
    [],
    state,
    undefined,
    [AGENT],
    undefined,
    { ...persistence, resumed: true },
  );
  assert.deepEqual(await autoModeState(second, sessionId), {
    enabled: false,
    records: THREE_RECORDS,
  });
});

test("(happy path) an owner run of re@1 reads a node that the message names with no approval, and a node that it does not name only after an approval", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      evidenceCall(target, 0, 0),
      evidenceCall(target, 1, 0),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [ALPHA_TEXT] }, { produced: [GAMMA_TEXT] }] },
  );
  const [nodeX, nodeY] = target.nodes as [SeededNode, SeededNode];
  completed(await message(fixture, session.id, `Review ${nodeX.nodeId}`));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.input.node_id, nodeY.nodeId);
  completed(await decide(fixture, session.id, pending.tool_call_id, true));
  const results = toolResults(await untilIdle(fixture, session.id, t.signal));
  assert.deepEqual(
    results.map(({ isError }) => isError),
    [false, false],
  );
  assert.ok(results[0]!.text.includes(ALPHA_TEXT));
  assert.ok(results[1]!.text.includes(GAMMA_TEXT));
});

test("(security: authorization) with auto mode off the read of a node that the message names shows an approval", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [evidenceCall(target, 0, 0), fauxAssistantMessage(ANSWER)],
    target,
    { nodes: [{ produced: [ALPHA_TEXT] }] },
  );
  const [nodeX] = target.nodes as [SeededNode];
  completed(await setAutoMode(fixture, session.id, false));
  completed(await message(fixture, session.id, `Review ${nodeX.nodeId}`));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.input.node_id, nodeX.nodeId);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
});

test("(security: authorization) a message grant ends with its run, so after auto mode goes off the read of the same node shows an approval", async (t) => {
  const target: EvidenceTarget = { nodes: [] };
  const { fixture, session } = await evidenceFixture(
    t,
    [
      evidenceCall(target, 0, 0),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, 0, 0),
      fauxAssistantMessage(ANSWER),
      evidenceCall(target, 0, 0),
      fauxAssistantMessage(ANSWER),
    ],
    target,
    { nodes: [{ produced: [ALPHA_TEXT] }] },
  );
  const [nodeX] = target.nodes as [SeededNode];
  completed(await message(fixture, session.id, `Review ${nodeX.nodeId}`));
  const first = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(first).map(({ isError }) => isError),
    [false],
  );
  completed(await message(fixture, session.id, QUESTION));
  const unnamed = await untilApproval(fixture, session.id, t.signal);
  assert.equal(unnamed.input.node_id, nodeX.nodeId);
  completed(await decide(fixture, session.id, unnamed.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  completed(await setAutoMode(fixture, session.id, false));
  completed(await message(fixture, session.id, `Review ${nodeX.nodeId}`));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.input.node_id, nodeX.nodeId);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
});

const PROJECT_PAUSE = "project.pause";
const IMPORT_REQUEST = "Apply the import of the plan.";
const GUARD_RECORD_KIND = "guard";
const GUARD_REASON = "The run message directs this change.";
const CLASSIFIER_REASON = "zq-classifier-reason";
const CLASSIFIER_CONFIDENCE = 0.4242;
const NO_GUARD_CALLS = 0;

interface GuardTarget {
  input: Parameters<typeof fauxToolCall>[1];
  nodeId: string;
  request: string;
  quote: string;
}

interface VerdictOptions {
  verdict?: Record<string, unknown>;
  gate?: Promise<void>;
  started?: PromiseWithResolvers<void>;
}

function verdictStep(target: GuardTarget, options: VerdictOptions = {}) {
  return async () => {
    options.started?.resolve();
    await options.gate;
    return toolCall(GUARD_TOOL_NAME, {
      tier: "auto",
      confidence: GUARD_AUTO_CONFIDENCE,
      request_quote: target.quote,
      reason: GUARD_REASON,
      ...options.verdict,
    });
  };
}

function classifierConfirm(target: GuardTarget) {
  return verdictStep(target, {
    verdict: {
      tier: "confirm",
      confidence: CLASSIFIER_CONFIDENCE,
      reason: CLASSIFIER_REASON,
    },
  });
}

function criterionCall(target: GuardTarget) {
  return () => toolCall(toolName(CRITERION_SET), target.input);
}

async function guardedFixture(
  t: TestContext,
  options: {
    guard: boolean;
    script: (target: GuardTarget) => FauxResponseStep[];
  },
) {
  const target: GuardTarget = { input: {}, nodeId: "", request: "", quote: "" };
  const fixture = await workbenchFixture(
    t,
    options.script(target),
    undefined,
    undefined,
    [OPS, AGENT, REVIEW_AGENT, ...(options.guard ? [GUARD_AGENT] : [])],
  );
  const created = await createdNode(fixture);
  target.input = criterionToolInput(created);
  target.nodeId = created.nodeId;
  target.quote = `Set the criterion of ${created.nodeId}`;
  target.request = `${target.quote} to ${NEW_CRITERION}.`;
  const session = await createSession(fixture, undefined, OPS);
  return { fixture, session, target };
}

function guardCalls(fixture: Fixture) {
  return fixture.provider.calls.filter(
    ({ systemPrompt }) => systemPrompt === GUARD_PROMPT,
  );
}

function agentCalls(fixture: Fixture) {
  return fixture.provider.calls.filter(
    ({ systemPrompt }) => systemPrompt !== GUARD_PROMPT,
  );
}

function guardRecords(entries: readonly Entry[]) {
  return entries
    .map((entry) => entry.data as { kind?: string } | undefined)
    .filter((data) => data?.kind === GUARD_RECORD_KIND);
}

test("(happy path) a verdict auto at the threshold with a quote of the run message runs the call with no card and writes one guard record", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      verdictStep(x),
      fauxAssistantMessage(ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError }) => isError),
    [false],
  );
  assert.equal(await criterionOf(fixture, target.nodeId), NEW_CRITERION);
  assert.deepEqual(guardRecords(entries), [
    {
      kind: GUARD_RECORD_KIND,
      tool_call_id: toolCallIds(entries)[0],
      operation_id: CRITERION_SET,
      reason: GUARD_REASON,
    },
  ]);
  assert.equal(guardCalls(fixture).length, SINGLE);
  assert.equal(guardCalls(fixture)[0]!.apiKey, SPARE_KEY);
});

test("(invariant guard: provider identity) the guard runtime gets the agent provider of the guard enablement, never its credential name", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      verdictStep(x),
      fauxAssistantMessage(ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  await untilIdle(fixture, session.id, t.signal);
  const guard = fixture.configurations.filter(
    ({ model_identifier }) => model_identifier === GUARD_MODEL,
  );
  assert.equal(guard.length, SINGLE);
  assert.equal(guard[0]!.agent_provider, DEFAULT);
  assert.notEqual(guard[0]!.agent_provider, SPARE_CREDENTIAL);
});

test("(happy path) an R1 call runs with no card and no guard model call, and writes one guard record with reason reversible with no guard@1 enablement", async (t) => {
  const target = { input: {} };
  const fixture = await workbenchFixture(
    t,
    [
      () => toolCall(toolName(PROJECT_PAUSE), target.input),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [OPS],
  );
  const project = completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: PROJECT_NAME } },
      fixture.options,
    ),
  );
  target.input = resumeToolInput(project.id);
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, QUESTION));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.deepEqual(
    toolResults(entries).map(({ isError }) => isError),
    [false],
  );
  assert.notEqual(await pausedAt(fixture, project.id), NO_PAUSE);
  assert.deepEqual(guardRecords(entries), [
    {
      kind: GUARD_RECORD_KIND,
      tool_call_id: toolCallIds(entries)[0],
      operation_id: PROJECT_PAUSE,
      reason: GuardCause.Reversible,
    },
  ]);
  assert.equal(guardCalls(fixture).length, NO_GUARD_CALLS);
});

test("(security: authorization) an import with no retirement gives confirm with cause import and no model call, also when the classifier answers auto", async (t) => {
  const holder = { input: {} };
  const verdict = { quote: "" };
  const fixture = await workbenchFixture(
    t,
    [
      () => toolCall(toolName(IMPORT_APPLY), holder.input),
      fauxAssistantMessage(ANSWER),
      async () =>
        toolCall(GUARD_TOOL_NAME, {
          tier: "auto",
          confidence: GUARD_AUTO_CONFIDENCE,
          request_quote: verdict.quote,
          reason: GUARD_REASON,
        }),
    ],
    undefined,
    undefined,
    [OPS, AGENT, REVIEW_AGENT, GUARD_AGENT],
  );
  const target = await importTarget(fixture);
  verdict.quote = IMPORT_REQUEST;
  holder.input = importToolInput(target, {
    format: ImportFormat.Json,
    entries: [],
    confirmed_retirements: [],
  });
  const session = await createSession(fixture, undefined, OPS);
  completed(await message(fixture, session.id, IMPORT_REQUEST));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.operation_id, IMPORT_APPLY);
  assert.deepEqual(pending.guard, {
    cause: GuardCause.Import,
    reason: null,
    confidence: null,
  });
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  assert.equal(guardCalls(fixture).length, NO_GUARD_CALLS);
});

test("(security: refused path) a call with guard@1 not enabled gives confirm with cause unavailable and no model call", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: false,
    script: (x) => [
      criterionCall(x),
      fauxAssistantMessage(ANSWER),
      verdictStep(x),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.deepEqual(pending.guard, UNAVAILABLE_GUARD);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  assert.equal(guardCalls(fixture).length, NO_GUARD_CALLS);
  assert.equal(await criterionOf(fixture, target.nodeId), ORIGINAL_CRITERION);
});

test("(security: refused path) after autoMode.set off the next call gives confirm with cause auto_mode_off and no model call", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      fauxAssistantMessage(ANSWER),
      verdictStep(x),
    ],
  });
  completed(await setAutoMode(fixture, session.id, false));
  completed(await message(fixture, session.id, target.request));
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.deepEqual(pending.guard, {
    cause: GuardCause.AutoModeOff,
    reason: null,
    confidence: null,
  });
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  assert.equal(guardCalls(fixture).length, NO_GUARD_CALLS);
});

test("(security: authorization) a queued owner item classifies against its own text", async (t) => {
  const first = heldAnswer(ANSWER);
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      first.step,
      criterionCall(x),
      verdictStep(x),
      fauxAssistantMessage(SECOND_ANSWER),
    ],
  });
  completed(await message(fixture, session.id, QUESTION));
  await queuedId(fixture, session.id, target.request);
  first.gate.resolve();
  await untilIdle(fixture, session.id, t.signal);
  const calls = guardCalls(fixture);
  assert.equal(calls.length, SINGLE);
  const sent = calls[0]!.messages.find(({ role }) => role === USER_ROLE) as {
    content: string;
  };
  assert.equal(JSON.parse(sent.content).request, target.request);
  assert.equal(await criterionOf(fixture, target.nodeId), NEW_CRITERION);
});

test("(security: redaction) the agent context holds no guard reason, confidence or record after an approved and a rejected classifier card", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      classifierConfirm(x),
      criterionCall(x),
      classifierConfirm(x),
      fauxAssistantMessage(ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  const approved = await untilApproval(fixture, session.id, t.signal);
  assert.deepEqual(approved.guard, {
    cause: GuardCause.Classifier,
    reason: CLASSIFIER_REASON,
    confidence: CLASSIFIER_CONFIDENCE,
  });
  completed(await decide(fixture, session.id, approved.tool_call_id, true));
  const rejected = await untilApproval(fixture, session.id, t.signal);
  assert.notEqual(rejected.tool_call_id, approved.tool_call_id);
  completed(await decide(fixture, session.id, rejected.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  const context = JSON.stringify(agentCalls(fixture).map((c) => c.messages));
  assert.ok(!context.includes(CLASSIFIER_REASON));
  assert.ok(!context.includes(String(CLASSIFIER_CONFIDENCE)));
  assert.ok(!context.includes(`"kind":"${GUARD_RECORD_KIND}"`));
});

test("(invariant guard: rollback) an abort of the run during classification blocks the call and leaves no pending approval", async (t) => {
  const started = Promise.withResolvers<void>();
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      async (_context, options) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        return verdictStep(x)();
      },
    ],
  });
  completed(await message(fixture, session.id, target.request));
  await started.promise;
  completed(await stopSession(fixture, session.id));
  const answer = await snapshotOf(fixture, session.id);
  assert.equal(answer.snapshot.pending_approval, null);
  assert.equal(answer.snapshot.run_active, false);
  assert.equal(await criterionOf(fixture, target.nodeId), ORIGINAL_CRITERION);
});

test("(invariant guard: two-writer race) a set to off while the classifier runs gives confirm with cause auto_mode_off", async (t) => {
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      verdictStep(x, { gate: gate.promise, started }),
      fauxAssistantMessage(ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  await started.promise;
  completed(await setAutoMode(fixture, session.id, false));
  gate.resolve();
  const pending = await untilApproval(fixture, session.id, t.signal);
  assert.equal(pending.guard?.cause, GuardCause.AutoModeOff);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  await untilIdle(fixture, session.id, t.signal);
  assert.equal(await criterionOf(fixture, target.nodeId), ORIGINAL_CRITERION);
});

test("(invariant guard: data loss) a rejection leaves auto mode on and the next classified call goes to the classifier", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      classifierConfirm(x),
      fauxAssistantMessage(ANSWER),
      criterionCall(x),
      verdictStep(x),
      fauxAssistantMessage(SECOND_ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  const pending = await untilApproval(fixture, session.id, t.signal);
  completed(await decide(fixture, session.id, pending.tool_call_id, false));
  const entries = await untilIdle(fixture, session.id, t.signal);
  assert.equal(
    (await snapshotOf(fixture, session.id)).snapshot.auto_mode,
    true,
  );
  completed(await message(fixture, session.id, target.request));
  const next = await untilIdle(
    fixture,
    session.id,
    t.signal,
    entries.at(-1)!.id as string,
  );
  assert.deepEqual(
    toolResults(next).map(({ isError }) => isError),
    [false],
  );
  assert.equal(guardCalls(fixture).length, TWO_RESULTS);
  assert.equal(await criterionOf(fixture, target.nodeId), NEW_CRITERION);
});

test("(invariant guard: data loss) a Stop with auto mode off leaves it off", async (t) => {
  const held = heldAnswer(ANSWER);
  const { fixture, session } = await guardedFixture(t, {
    guard: true,
    script: () => [held.step],
  });
  completed(await setAutoMode(fixture, session.id, false));
  completed(await message(fixture, session.id, QUESTION));
  const stopping = stopSession(fixture, session.id);
  held.gate.resolve();
  completed(await stopping);
  assert.equal(
    (await snapshotOf(fixture, session.id)).snapshot.auto_mode,
    false,
  );
});

test("(invariant guard: data loss) a guard record between a tool call and its result keeps the session context valid", async (t) => {
  const { fixture, session, target } = await guardedFixture(t, {
    guard: true,
    script: (x) => [
      criterionCall(x),
      verdictStep(x),
      fauxAssistantMessage(ANSWER),
    ],
  });
  completed(await message(fixture, session.id, target.request));
  const entries = await untilIdle(fixture, session.id, t.signal);
  const kinds = entries.map((entry) =>
    guardRecords([entry]).length > NO_GUARD_CALLS
      ? GUARD_RECORD_KIND
      : (entry.message as { role?: string } | undefined)?.role,
  );
  const record = kinds.indexOf(GUARD_RECORD_KIND);
  assert.equal(kinds[record - SINGLE], ASSISTANT_ROLE);
  assert.equal(kinds[record + SINGLE], TOOL_RESULT);
  const roles = (agentCalls(fixture)[SINGLE]!.messages as { role: string }[])
    .map(({ role }) => role)
    .filter((role) => role !== SYSTEM_ROLE);
  assert.deepEqual(roles, [
    USER_ROLE,
    ASSISTANT_ROLE,
    USER_ROLE,
    ASSISTANT_ROLE,
    TOOL_RESULT,
  ]);
});

const NOTE_KIND = "note";
const OWNER_NOTE = "Check the billing node before the release.";
const GUEST_NOTE = "Mai asks which node blocks the release.";
const GUEST_NAME = "Mai";
const OWNER_NAME = "Ulrich";
const NOTE_PAUSE_MS = 5;
const TWO_NOTES = 2;
const TWO_CALLS = 2;
const THREE_CALLS = 3;
const HOST_CALL = 1;
const SECOND_RE_CALL = 2;
const NOTE_TIMEOUT_MS = 60000;
const MENTION_RE = "@RE what is blocked?";
const MENTION_HOST = "@Yumi what is blocked?";
const FOLLOW_UP = "What else is open?";
const FORK_NOTE_SUMMARY = "Goal: finish the release.";

async function sharedHost(
  t: TestContext,
  script: FauxResponseStep[],
  enabled: readonly string[] = [OPS, REVIEW_AGENT],
  agentName = OPS,
) {
  const fixture = await workbenchFixture(
    t,
    script,
    temporaryDirectory(),
    undefined,
    enabled,
  );
  const session = await createSession(fixture, undefined, agentName);
  return { fixture, session };
}

async function inviteGuest(fixture: Fixture, sessionId: string) {
  return completed(
    await fixture.workbench["invite.create"](
      {
        params: { session_id: sessionId },
        query: {},
        body: {
          invitee_name: GUEST_NAME,
          project_ids: await invitedProjectIds(fixture),
          granted_operations: [],
        },
      },
      fixture.options,
    ),
  );
}

function noteRecords(entries: readonly Entry[]): Entry[] {
  return recordsOf(entries).filter(
    (entry) => (entry.data as { kind?: string }).kind === NOTE_KIND,
  );
}

function providerText(fixture: Fixture, call: number): string {
  return JSON.stringify(fixture.provider.calls[call]!.messages);
}

test(
  "(happy path, note) an untagged message in a shared conversation appends a note, starts no run and the next run of each member holds it with its author",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const { fixture, session } = await sharedHost(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
      fauxAssistantMessage(THIRD_ANSWER),
    ]);
    await inviteGuest(fixture, session.id);
    const first = completed(await message(fixture, session.id, MENTION_RE));
    assert.equal(first.kind, MessageKind.Run);
    await untilIdle(fixture, session.id, t.signal);
    await delay(NOTE_PAUSE_MS);
    const note = completed(await message(fixture, session.id, OWNER_NOTE));
    assert.deepEqual(note, {
      session_id: session.id,
      agent_name: null,
      run_active: false,
      queued_message_id: null,
      cleared: [],
      kind: MessageKind.Note,
    });
    await fixture.workbenchService.note(
      session.id,
      { kind: AuthorKind.Guest, name: GUEST_NAME },
      GUEST_NOTE,
    );
    assert.equal(fixture.provider.calls.length, SINGLE);
    completed(await message(fixture, session.id, MENTION_HOST));
    await untilIdle(fixture, session.id, t.signal);
    completed(await message(fixture, session.id, MENTION_RE));
    await untilIdle(fixture, session.id, t.signal);
    assert.equal(fixture.provider.calls.length, THREE_CALLS);
    for (const call of [HOST_CALL, SECOND_RE_CALL]) {
      const text = providerText(fixture, call);
      assert.ok(text.includes(`${OWNER_NAME} (owner): ${OWNER_NOTE}`), text);
      assert.ok(text.includes(`${GUEST_NAME} (guest): ${GUEST_NOTE}`), text);
    }
    assert.equal(
      noteRecords(await sessionEntries(fixture, session.id)).length,
      TWO_NOTES,
    );
  },
);

test(
  "(happy path, mention) a message with a leading mention in a shared conversation starts a run",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const { fixture, session } = await sharedHost(t, [
      fauxAssistantMessage(ANSWER),
    ]);
    await inviteGuest(fixture, session.id);
    const accepted = completed(await message(fixture, session.id, MENTION_RE));
    assert.equal(accepted.kind, MessageKind.Run);
    assert.equal(accepted.agent_name, REVIEW_AGENT);
    assert.equal(accepted.run_active, true);
    await untilIdle(fixture, session.id, t.signal);
    assert.equal(fixture.provider.calls.length, SINGLE);
    assert.equal(
      noteRecords(await sessionEntries(fixture, session.id)).length,
      NO_QUEUED_MESSAGES,
    );
  },
);

test(
  "(happy path, unshared) after the last revoke an untagged message runs the member that answered last",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const { fixture, session } = await sharedHost(t, [
      fauxAssistantMessage(ANSWER),
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    const invite = await inviteGuest(fixture, session.id);
    completed(await message(fixture, session.id, MENTION_RE));
    await untilIdle(fixture, session.id, t.signal);
    completed(
      await fixture.workbench["invite.revoke"](
        { params: { invite_id: invite.id }, query: {}, body: null },
        fixture.options,
      ),
    );
    const accepted = completed(await message(fixture, session.id, FOLLOW_UP));
    assert.equal(accepted.kind, MessageKind.Run);
    assert.equal(accepted.agent_name, REVIEW_AGENT);
    await untilIdle(fixture, session.id, t.signal);
    assert.equal(fixture.provider.calls.length, TWO_CALLS);
  },
);

test(
  "(security, guest attribution) the fork material holds an owner note and a guest note marked with its author",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const { fixture, session } = await sharedHost(
      t,
      [
        fauxAssistantMessage(ANSWER),
        fauxAssistantMessage(FORK_NOTE_SUMMARY),
        pass(),
        fauxAssistantMessage(SECOND_ANSWER),
      ],
      [AGENT, GUARD_AGENT],
      AGENT,
    );
    completed(await message(fixture, session.id, QUESTION));
    await untilIdle(fixture, session.id, t.signal);
    await inviteGuest(fixture, session.id);
    completed(await message(fixture, session.id, OWNER_NOTE));
    await fixture.workbenchService.note(
      session.id,
      { kind: AuthorKind.Guest, name: GUEST_NAME },
      GUEST_NOTE,
    );
    completed(await forkOf(fixture, session.id, FOLLOW_UP));
    const [summarizer] = callsOf(fixture, FORK_SUMMARY_PROMPT);
    const { conversation } = userRequestOf(summarizer!);
    assert.ok(
      conversation!.includes(`${GUEST_NAME} (guest) wrote: ${GUEST_NOTE}`),
    );
    assert.ok(conversation!.includes(`${OWNER_NAME} (owner): ${OWNER_NOTE}`));
    assert.ok(!conversation!.includes(`${OWNER_NAME} (guest)`));
  },
);

test(
  "(security, guard floor) an owner note leaves the auto mode unchanged",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const { fixture, session } = await sharedHost(t, []);
    completed(await setAutoMode(fixture, session.id, false));
    await inviteGuest(fixture, session.id);
    const before = await autoModeState(fixture, session.id);
    const note = completed(await message(fixture, session.id, OWNER_NOTE));
    assert.equal(note.kind, MessageKind.Note);
    assert.deepEqual(await autoModeState(fixture, session.id), before);
    assert.equal(before.enabled, false);
    assert.equal(fixture.provider.calls.length, NO_QUEUED_MESSAGES);
  },
);

test(
  "(invariant, two-writer race) a note during a run leaves buildSessionContext unchanged",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const held = heldAnswer(ANSWER);
    const { fixture, session } = await sharedHost(t, [held.step]);
    await inviteGuest(fixture, session.id);
    completed(await message(fixture, session.id, MENTION_HOST));
    await untilProviderCall(fixture, t.signal);
    const note = completed(await message(fixture, session.id, OWNER_NOTE));
    assert.equal(note.kind, MessageKind.Note);
    assert.equal(note.run_active, true);
    held.gate.resolve();
    await untilIdle(fixture, session.id, t.signal);
    const entries = await sessionEntries(fixture, session.id);
    const [record] = noteRecords(entries);
    assert.ok(record);
    const without = entries
      .filter((entry) => entry !== record)
      .map((entry) =>
        entry.parentId === record.id
          ? { ...entry, parentId: record.parentId }
          : entry,
      );
    const { buildSessionContext } = await loadPi();
    assert.deepEqual(
      buildSessionContext(entries as never),
      buildSessionContext(without as never),
    );
    assert.equal(fixture.provider.calls.length, SINGLE);
  },
);

test(
  "(invariant, two-writer race) an untagged item queued before invite.create starts by D8",
  { timeout: NOTE_TIMEOUT_MS },
  async (t) => {
    const held = heldAnswer(ANSWER);
    const { fixture, session } = await sharedHost(t, [
      held.step,
      fauxAssistantMessage(SECOND_ANSWER),
    ]);
    completed(await message(fixture, session.id, QUESTION));
    await untilProviderCall(fixture, t.signal);
    const queued = completed(await message(fixture, session.id, FOLLOW_UP));
    assert.equal(queued.kind, MessageKind.Run);
    assert.ok(queued.queued_message_id);
    await inviteGuest(fixture, session.id);
    held.gate.resolve();
    await untilIdle(fixture, session.id, t.signal);
    assert.equal(fixture.provider.calls.length, TWO_CALLS);
    assert.ok(providerText(fixture, SINGLE).includes(FOLLOW_UP));
    assert.equal(
      noteRecords(await sessionEntries(fixture, session.id)).length,
      NO_QUEUED_MESSAGES,
    );
  },
);

const FOUR_RESULTS = 4;
const FOREIGN_PROJECT_NAME = "other-ledger";
const SCOPE_MENTION =
  "@Yumi read the projects and pause the node of the other project.";
const SCOPE_TEST_TIMEOUT_MS = 60000;

test(
  "(security) resolver test 22: a guest-started run with scope P1 leaks no name or id of P2 in any tool result",
  { timeout: SCOPE_TEST_TIMEOUT_MS },
  async (t) => {
    const target = { first: "", second: "", secondNode: "" };
    const fixture = await workbenchFixture(
      t,
      [
        toolCall(toolName("project.list"), { query: {} }),
        () =>
          toolCall(toolName("mission.get"), {
            params: { project_id: target.first },
          }),
        () =>
          toolCall(toolName("mission.get"), {
            params: { project_id: target.second },
          }),
        () =>
          toolCall(toolName("mission.node.pause"), {
            params: { node_id: target.secondNode },
            body: {
              reason: "hold",
              expected_mission_version: FIRST_BINDING_SET,
              expected_state: NodeState.Available,
              expected_attempt: NO_QUEUED_MESSAGES,
            },
          }),
        fauxAssistantMessage(ANSWER),
      ],
      undefined,
      undefined,
      [OPS, AGENT, REVIEW_AGENT],
    );
    const first = await createdNode(fixture);
    const second = await createdNode(fixture, FOREIGN_PROJECT_NAME);
    Object.assign(target, {
      first: first.projectId,
      second: second.projectId,
      secondNode: second.nodeId,
    });
    const session = await createSession(fixture, undefined, OPS);
    const invite = completed(
      await fixture.workbench["invite.create"](
        {
          params: { session_id: session.id },
          query: {},
          body: {
            invitee_name: GUEST_NAME,
            project_ids: [first.projectId],
            granted_operations: [],
          },
        },
        fixture.options,
      ),
    );
    const joined = completed(
      await fixture.workbench["invite.join"](
        {
          params: {},
          query: {},
          body: { invite_token: invite.invite_token, name: GUEST_NAME },
        },
        fixture.options,
      ),
    );
    const guest = testGuestIdentity({
      guestId: joined.guest_id,
      name: GUEST_NAME,
      inviteId: invite.id,
      sessionId: session.id,
      invitedBy: identity.accountId,
      reader: testReadOnlyIdentity(identity.accountId, {
        inviteId: invite.id,
        projectIds: [first.projectId],
      }),
      jti: "resolver-test-22",
    });
    await fixture.workbenchService.guestMessage(
      guest,
      SCOPE_MENTION,
      background,
    );
    await untilIdle(fixture, session.id, t.signal);
    const results = toolResults(await eventEntries(fixture, session.id));
    assert.equal(results.length, FOUR_RESULTS);
    const text = results.map((result) => result.text).join("\n");
    assert.ok(text.includes(first.projectId));
    for (const leaked of [
      second.projectId,
      second.nodeId,
      FOREIGN_PROJECT_NAME,
    ])
      assert.ok(!text.includes(leaked), leaked);
    assert.deepEqual(
      results.slice(-TWO_RESULTS).map((result) => result.text),
      [WORKBENCH_PROJECT_SCOPE_TEXT, WORKBENCH_PROJECT_SCOPE_TEXT],
    );
    assert.equal(
      (await nodeOf(fixture, second.nodeId)).state,
      NodeState.Available,
    );
  },
);
