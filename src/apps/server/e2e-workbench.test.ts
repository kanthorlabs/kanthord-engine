import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { directClient } from "../../gateway/index.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import { agentOperations } from "../../agent/contract.ts";
import { loadPi } from "../../agent/pi.ts";
import { scriptedProvider } from "../../agent/test-support.ts";
import { llmOperations } from "../../llm/contract.ts";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import {
  WORKBENCH_CONFIGURATION_ENTRY,
  WorkbenchErrorCode,
  workbenchOperations,
  type WorkbenchConfiguration,
} from "../../workbench/contract.ts";
import type { WorkbenchModelRuntimeFactory } from "../../workbench/index.ts";
import { gatewayFixture } from "./test-support.ts";

const AGENT = "swe@1";
const ANTHROPIC = "anthropic";
const DEFAULT = "default";
const BACKUP = "backup";
const SONNET = "claude-sonnet-4-5";
const HAIKU = "claude-haiku-4-5";
const OFF = "off" as const;
const LOW = "low" as const;
const PRIMARY_CREDENTIAL = "anthro-1";
const BACKUP_CREDENTIAL = "anthro-2";
const PRIMARY_KEY = "primary-scripted-key";
const BACKUP_KEY = "backup-scripted-key";
const CustomType = "custom";
const ModelChange = "model_change";
const ThinkingChange = "thinking_level_change";
const SINGLE = 1;
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

function scriptedFactory(script: FauxResponseStep[]): {
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
      const runtime = await createModelRuntime(await loadPi(), input);
      runtime.registerNativeProvider(provider.provider);
      return { runtime, model: resolveModel(runtime, input.configuration) };
    },
  };
}

async function workbenchFixture(
  t: TestContext,
  script: FauxResponseStep[] = [],
  stateDirectory = temporary(t),
) {
  const scripted = scriptedFactory(script);
  const fixture = await gatewayFixture(t, {
    stateDirectory,
    workbenchModelRuntimeFactory: scripted.factory,
  });
  const options = { identity };
  const llm = directClient(llmOperations, fixture.invocation);
  for (const [name, key] of [
    [PRIMARY_CREDENTIAL, PRIMARY_KEY],
    [BACKUP_CREDENTIAL, BACKUP_KEY],
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
  completed(
    await agent["enablement.put"](
      {
        params: { agentName: AGENT },
        query: {},
        body: {
          agentProviders: [
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
          defaultConfiguration: {
            agentProvider: DEFAULT,
            modelIdentifier: SONNET,
            reasoningEffort: OFF,
          },
        },
      },
      options,
    ),
  );
  return {
    ...fixture,
    stateDirectory,
    provider: scripted.provider,
    options,
    agent,
    workbenchService: fixture.workbench,
    workbench: directClient(workbenchOperations, fixture.invocation),
  };
}

async function createSession(
  fixture: Awaited<ReturnType<typeof workbenchFixture>>,
  configuration: WorkbenchConfiguration = {
    agentProvider: DEFAULT,
    modelIdentifier: SONNET,
    reasoningEffort: OFF,
  },
) {
  return completed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: { agentName: AGENT, ...configuration },
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
  assert.equal(session.agentName, AGENT);
  assert.equal(session.runActive, false);
  assert.deepEqual(session.configuration, {
    agentProvider: DEFAULT,
    modelIdentifier: SONNET,
    reasoningEffort: OFF,
  });
  const custom = entriesOf(session.entries, CustomType);
  assert.equal(custom.length, SINGLE);
  assert.equal(custom[0]!.customType, WORKBENCH_CONFIGURATION_ENTRY);
  assert.deepEqual(custom[0]!.data, { agentProvider: DEFAULT });
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
      { params: { sessionId: session.id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(read, session);
});

test("a configuration change appends the custom entry only when the agent provider changes", async (t) => {
  const fixture = await workbenchFixture(t);
  const session = await createSession(fixture);
  const params = { sessionId: session.id };
  const lowHaiku = {
    agentProvider: DEFAULT,
    modelIdentifier: HAIKU,
    reasoningEffort: LOW,
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
  const backup = { ...lowHaiku, agentProvider: BACKUP };
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
    [{ agentProvider: DEFAULT }, { agentProvider: BACKUP }],
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
          agentName: "unknown@1",
          agentProvider: DEFAULT,
          modelIdentifier: SONNET,
          reasoningEffort: OFF,
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
          agentName: AGENT,
          agentProvider: "absent",
          modelIdentifier: SONNET,
          reasoningEffort: OFF,
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
          agentName: AGENT,
          agentProvider: DEFAULT,
          modelIdentifier: "absent-model",
          reasoningEffort: OFF,
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
        params: { sessionId: session.id },
        query: {},
        body: {
          agentProvider: DEFAULT,
          modelIdentifier: SONNET,
          reasoningEffort: "max" as const,
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
        params: { sessionId: "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
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
      { params: {}, query: { agentName: "unknown@1" }, body: null },
      fixture.options,
    ),
    HttpStatus.NotFound,
    "agent.catalog.not_found",
  );
});

test("a stored session resumes from the last entry of each kind and lists through pi", async (t) => {
  const state = temporary(t);
  const pi = await loadPi();
  const id = "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const manager = pi.SessionManager.create(
    join(state, "workbench", AGENT),
    join(state, "pi", "sessions", "workbench", AGENT),
    { id },
  );
  manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
    agentProvider: DEFAULT,
  });
  manager.appendModelChange(ANTHROPIC, SONNET);
  manager.appendThinkingLevelChange(OFF);
  manager.appendCustomEntry(WORKBENCH_CONFIGURATION_ENTRY, {
    agentProvider: BACKUP,
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
  const listed = completed(
    await fixture.workbench["session.list"](
      { params: {}, query: { agentName: AGENT }, body: null },
      fixture.options,
    ),
  );
  assert.equal(listed.items.length, SINGLE);
  assert.equal(listed.items[0]!.id, id);
  assert.equal(listed.items[0]!.firstMessage, FIRST_MESSAGE);
  assert.ok(Number.isSafeInteger(listed.items[0]!.created));
  const read = completed(
    await fixture.workbench["session.get"](
      { params: { sessionId: id }, query: {}, body: null },
      fixture.options,
    ),
  );
  assert.deepEqual(read.configuration, {
    agentProvider: BACKUP,
    modelIdentifier: HAIKU,
    reasoningEffort: LOW,
  });
  const same = { ...read.configuration };
  completed(
    await fixture.workbench["session.configure"](
      { params: { sessionId: id }, query: {}, body: same },
      fixture.options,
    ),
  );
  const again = completed(
    await fixture.workbench["session.get"](
      { params: { sessionId: id }, query: {}, body: null },
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
    sessionId: session.id,
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
        params: { sessionId: session.id },
        query: {},
        body: {
          agentProvider: BACKUP,
          modelIdentifier: SONNET,
          reasoningEffort: OFF,
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
    sessionId: "workbench_session_01ARZ3NDEKTSV4RRFFQ69G5FAV",
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
      { params: { agentName: AGENT }, query: {}, body: null },
      fixture.options,
    ),
  );
  completed(
    await fixture.agent["enablement.disable"](
      {
        params: { agentName: AGENT },
        query: {},
        body: { expectedRevision: enablement.revision },
      },
      fixture.options,
    ),
  );
  await assert.rejects(view.read(ANTHROPIC), {
    code: WorkbenchErrorCode.AuthorizationRefused,
  });
});
