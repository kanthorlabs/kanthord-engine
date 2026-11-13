import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
  getSystemMessageText,
  type SystemMessage,
} from "@earendil-works/pi-ai";
import {
  BASE_PROMPT,
  SWE_AGENT_PROMPT,
  WORKBENCH_PROMPT,
} from "../../agent/prompt-assets.ts";
import { directClient } from "../../gateway/index.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
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
  agentOperations,
  GuardClass,
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
import { scriptedProvider } from "../../agent/test-support.ts";
import { llmOperations } from "../../llm/contract.ts";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import {
  MessageDelivery,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_EXPIRY_REASON,
  WORKBENCH_QUEUE_LIMIT,
  WORKBENCH_REJECTION_REASON,
  type WorkbenchConfiguration,
  WorkbenchErrorCode,
  workbenchOperations,
} from "../../workbench/contract.ts";
import {
  toolName,
  type WorkbenchModelRuntimeFactory,
} from "../../workbench/index.ts";
import { MissionErrorCode, missionOperations } from "../../mission/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import { COVERING_WORKER_BINDINGS, gatewayFixture } from "./test-support.ts";
import { framing, PromptConsumer } from "../../agent/prompt-render.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";

const AGENT = "swe@1";
const REVIEW_AGENT = "re@1";
const OPS = "ops@1";
const ANTHROPIC = "anthropic";
const DEFAULT = "default";
const BACKUP = "backup";
const SONNET = "claude-sonnet-4-5";
const HAIKU = "claude-haiku-4-5";
const OFF = "off" as const;
const LOW = "low" as const;
const PRIMARY_CREDENTIAL = "anthro-1";
const BACKUP_CREDENTIAL = "anthro-2";
const SPARE_CREDENTIAL = "anthro-3";
const PRIMARY_KEY = "primary-scripted-key";
const BACKUP_KEY = "backup-scripted-key";
const SPARE_KEY = "spare-scripted-key";
const CustomType = "custom";
const ModelChange = "model_change";
const ThinkingChange = "thinking_level_change";
const SINGLE = 1;
const NO_QUEUED_MESSAGES = 0;
const NO_UNKEPT = 0;
const HOST_HOME = "/home/kanthord_host";
const MESSAGE_ENTRY = "message";
const SYSTEM_ROLE = "system";
const INVALID_OVERRIDE_TEXT = "bell\u0007";
const OVERRIDE_TEXT = "Answer in one sentence.";
const QUESTION = "How many objectives are open?";
const ANSWER = "Two objectives are open.";
const FIRST_MESSAGE = "List the open objectives.";
const identity = testHumanIdentity("kanthord", "Ulrich", "workbench-test");

function completed<T>(result: OperationResult<T>): T {
  assert.equal(
    result.type,
    OperationResultType.Completed,
    JSON.stringify(result),
  );
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

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

function scriptedFactory(
  script: FauxResponseStep[],
  beforeOpen?: () => Promise<void>,
): {
  factory: WorkbenchModelRuntimeFactory;
  provider: ReturnType<typeof scriptedProvider>;
} {
  const provider = scriptedProvider(script, {
    providerId: ANTHROPIC,
    modelIdentifier: SONNET,
    models: [
      { id: SONNET, reasoning: false },
      { id: HAIKU, reasoning: true },
    ],
  });
  return {
    provider,
    factory: async (input) => {
      await beforeOpen?.();
      const runtime = await createModelRuntime(await loadPi(), input);
      runtime.registerNativeProvider(provider.provider);
      return { runtime, model: resolveModel(runtime, input.configuration) };
    },
  };
}

async function workbenchFixture(
  t: TestContext,
  script: FauxResponseStep[] = [],
  stateDirectory?: string,
  agentDirectory = temporary(t),
  enabledAgents: readonly string[] = [AGENT],
  beforeOpen?: () => Promise<void>,
) {
  const scripted = scriptedFactory(script, beforeOpen);
  const fixture = await gatewayFixture(t, {
    stateDirectory,
    agentDirectory,
    workbenchModelRuntimeFactory: scripted.factory,
  });
  const options = { identity };
  const llm = directClient(llmOperations, fixture.invocation);
  for (const [name, key] of [
    [PRIMARY_CREDENTIAL, PRIMARY_KEY],
    [BACKUP_CREDENTIAL, BACKUP_KEY],
    [SPARE_CREDENTIAL, SPARE_KEY],
  ] as const)
    completed(
      await llm.create(
        {
          params: {},
          query: {},
          body: { name, platform: ANTHROPIC, metadata: null, secret: { key } },
        },
        options,
      ),
    );
  const agent = directClient(agentOperations, fixture.invocation);
  for (const agentName of enabledAgents)
    completed(
      await agent["enablement.put"](
        {
          params: { agent_name: agentName },
          query: {},
          body: {
            agent_providers: [
              {
                name: DEFAULT,
                provider: ANTHROPIC,
                credential: PRIMARY_CREDENTIAL,
              },
              {
                name: BACKUP,
                provider: ANTHROPIC,
                credential: BACKUP_CREDENTIAL,
              },
            ],
            default_configuration: {
              agent_provider: DEFAULT,
              model_identifier: SONNET,
              reasoning_effort: OFF,
            },
            fallback_configurations: [],
          },
        },
        options,
      ),
    );
  return {
    ...fixture,
    provider: scripted.provider,
    options,
    agent,
    projects: directClient(projectOperations, fixture.invocation),
    missions: directClient(missionOperations, fixture.invocation),
    workbenchService: fixture.workbench,
    workbench: directClient(workbenchOperations, fixture.invocation),
  };
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
  failed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agent_name: peAgent }, body: null },
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
    HttpStatus.NotFound,
    "agent.catalog.not_found",
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
      await fixture.workbench["session.events"](
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
    run_active: true,
    queued_message_id: null,
    cleared: [],
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
const PROJECT_NAME = "operations";
const UNKNOWN_NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIRST_BINDING_SET = 1;
const NO_PAUSE = null;
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

async function createNode(fixture: Fixture): Promise<string> {
  const project = completed(
    await fixture.projects.create(
      { params: {}, query: {}, body: { name: PROJECT_NAME } },
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
  ) as { revisions: { node_id: string }[] };
  return created.revisions[0]!.node_id;
}

async function resumeFixture(t: TestContext, stateDirectory?: string) {
  const target = { projectId: "" };
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        toolCall(toolName(PROJECT_RESUME), resumeToolInput(target.projectId)),
      fauxAssistantMessage(ANSWER),
    ],
    stateDirectory,
    undefined,
    [OPS],
  );
  target.projectId = await pausedProject(fixture);
  const session = await createSession(fixture, undefined, OPS);
  return { fixture, session, projectId: target.projectId };
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
      await fixture.workbench["session.events"](
        {
          params: { session_id: sessionId },
          query: version === undefined ? {} : { version },
          body: null,
        },
        fixture.options,
      ),
    );
    if (answer.snapshot.pending_approval)
      return answer.snapshot.pending_approval;
    assert.ok(answer.snapshot.run_active);
    version = answer.version;
  }
}

test("a poll answers at once when the snapshot changed after the version that the client holds", async (t) => {
  const { fixture, session } = await resumeFixture(t);
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
    const { builtin, operation } = getAgentDeclaration(agentName)!.tools;
    assert.deepEqual(
      [...tools].sort(),
      [...builtin, ...operation.map(toolName)].sort(),
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
    const operations = tools.slice(local.length);
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
  const { fixture, session, projectId } = await resumeFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  assert.equal(pending.operation_id, PROJECT_RESUME);
  assert.deepEqual(pending.input, resumeToolInput(projectId));
  assert.notEqual(await pausedAt(fixture, projectId), NO_PAUSE);
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
  assert.equal(await pausedAt(fixture, projectId), NO_PAUSE);
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
  const { fixture, session } = await resumeFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  const waiting = await listedSession(fixture, sessionId);
  assert.equal(waiting?.run_active, true);
  assert.deepEqual(waiting?.pending_approval, {
    tool_call_id: pending.tool_call_id,
    operation_id: PROJECT_RESUME,
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
  const { fixture, session, projectId } = await resumeFixture(t);
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
      toolName: toolName(PROJECT_RESUME),
      isError: true,
      text: WORKBENCH_REJECTION_REASON,
    },
  ]);
  assert.notEqual(await pausedAt(fixture, projectId), NO_PAUSE);
});

test("an abort rejects every pending approval", async (t) => {
  const { fixture, session, projectId } = await resumeFixture(t);
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
  assert.notEqual(await pausedAt(fixture, projectId), NO_PAUSE);
});

const SETTLE_TURNS = 20;
const ASSISTANT_ROLE = "assistant";

function enableTimers(t: TestContext): void {
  t.mock.timers.enable({ apis: ["setTimeout"] });
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
  const { fixture, session, projectId } = await resumeFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.deepEqual(toolResults(entries), [
    {
      toolName: toolName(PROJECT_RESUME),
      isError: true,
      text: WORKBENCH_EXPIRY_REASON,
    },
  ]);
  assert.notEqual(await pausedAt(fixture, projectId), NO_PAUSE);
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

test("(invariant guard) an approve one millisecond before the expiry runs the call and a later tick changes nothing", async (t) => {
  enableTimers(t);
  const { fixture, session, projectId } = await resumeFixture(t);
  const sessionId = session.id;
  const wait = fixture.config.workbench.approval_wait_ms;
  completed(await message(fixture, sessionId, QUESTION));
  const pending = await untilApproval(fixture, sessionId, t.signal);
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
  assert.equal(await pausedAt(fixture, projectId), NO_PAUSE);
  const before = await snapshotOf(fixture, sessionId);
  t.mock.timers.tick(wait);
  await setImmediate();
  const after = await snapshotOf(fixture, sessionId);
  assert.equal(after.version, before.version);
  assert.equal(after.snapshot.run_active, false);
});

test("(invariant guard) an abort and then a full tick leave the version unchanged", async (t) => {
  enableTimers(t);
  const { fixture, session } = await resumeFixture(t);
  const sessionId = session.id;
  completed(await message(fixture, sessionId, QUESTION));
  await untilApproval(fixture, sessionId, t.signal);
  completed(
    await fixture.workbench["session.abort"](
      { params: { session_id: sessionId }, query: {}, body: null },
      fixture.options,
    ),
  );
  const before = await snapshotOf(fixture, sessionId);
  t.mock.timers.tick(fixture.config.workbench.approval_wait_ms);
  await setImmediate();
  assert.equal((await snapshotOf(fixture, sessionId)).version, before.version);
});

test("(security) the expiry of the first mutation of a batch ends the run before the second card and any provider call", async (t) => {
  enableTimers(t);
  const target = { projectId: "" };
  const fixture = await workbenchFixture(
    t,
    [
      () =>
        fauxAssistantMessage(
          [
            fauxToolCall(
              toolName(PROJECT_RESUME),
              resumeToolInput(target.projectId),
            ),
            fauxToolCall(
              toolName(PROJECT_RESUME),
              resumeToolInput(target.projectId),
            ),
          ],
          { stopReason: TOOL_USE },
        ),
      fauxAssistantMessage(ANSWER),
    ],
    undefined,
    undefined,
    [OPS],
  );
  target.projectId = await pausedProject(fixture);
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
  assert.notEqual(await pausedAt(fixture, target.projectId), NO_PAUSE);
  assert.equal(fixture.provider.calls.length, SINGLE);
});

test("(invariant guard) a service stop with a pending card and then a full tick throws nothing and notifies nothing", async (t) => {
  enableTimers(t);
  const { fixture, session } = await resumeFixture(t);
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
  const first = await resumeFixture(t, state);
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
  assert.ok(JSON.stringify(resumed.entries).includes(toolName(PROJECT_RESUME)));
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

function heldAnswer(text: string) {
  const gate = Promise.withResolvers<void>();
  return {
    gate,
    step: async () => {
      await gate.promise;
      return fauxAssistantMessage(text);
    },
  };
}

function untilAbort(text: string) {
  return async (
    _context: unknown,
    options?: { signal?: AbortSignal | undefined },
  ) => {
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) resolve();
      options?.signal?.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return fauxAssistantMessage(text);
  };
}

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
    { id: firstId, text: FIRST_QUEUED },
    { id: secondId, text: SECOND_QUEUED },
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
    { id: firstId, text: FIRST_QUEUED },
    { id: secondId, text: SECOND_QUEUED },
  ]);
  assert.ok(replaced.queued_message_id);
  const entries = await untilIdle(fixture, sessionId, t.signal);
  assert.equal(signals[0]?.aborted, true);
  assert.deepEqual(texts(entries, "user"), [QUESTION, THIRD_ANSWER]);
  assert.equal(fixture.provider.calls.length, SINGLE + SINGLE);
  assert.deepEqual((await snapshotOf(fixture, sessionId)).snapshot.queue, []);
});

test("(security) a replace during a pending approval blocks the call and never invokes the operation", async (t) => {
  const { fixture, session, projectId } = await resumeFixture(t);
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
    [{ name: toolName(PROJECT_RESUME), isError: true }],
  );
  assert.deepEqual(texts(entries, "user"), [QUESTION, FIRST_QUEUED]);
  assert.notEqual(await pausedAt(fixture, projectId), NO_PAUSE);
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
    { id: firstId, text: FIRST_QUEUED },
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
      { id: firstId, text: FIRST_QUEUED },
      { id: secondId, text: SECOND_QUEUED },
    ],
  });
  for (let turn = 0; turn < SETTLE_TURNS; turn++) await setImmediate();
  assert.equal(fixture.provider.calls.length, SINGLE);
  const answer = await snapshotOf(fixture, sessionId);
  assert.equal(answer.snapshot.run_active, false);
  assert.deepEqual(answer.snapshot.queue, []);
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
  type Claimer = { claim(session: unknown, clearError: boolean): unknown };
  const service = fixture.workbenchService as unknown as Claimer;
  const claim = service.claim.bind(service);
  let replacing: ReturnType<typeof replaceMessage> | null = null;
  t.mock.method(service, "claim", (claimed: unknown, clearError: boolean) => {
    const run = claim(claimed, clearError);
    if (!clearError && !replacing)
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
