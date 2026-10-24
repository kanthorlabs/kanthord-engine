import { ExecutionBudget } from "./budget.ts";
import assert from "node:assert/strict";
import { implementFixture, task, unusedHostTools } from "./test-support.ts";
import { taskWork } from "./steps-implement.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background, CancellationContext } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { temporary, hostEnvironment } from "../../kernel/test-support.ts";
import {
  credentialRedaction,
  openNativeAgent,
  promptStop,
} from "./native-agent.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { CodedError } from "../../kernel/errors.ts";
import { ExecutionIntent } from "../contract.ts";
import {
  WorkerMethod,
  type ExecutionSetup,
  type HostTools,
} from "../contract.ts";
import { renderWorkPrompt } from "../../agent/prompt-composer.ts";
import {
  anthropicAgent,
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedModelRuntime,
  scriptedProvider,
  SETUP_PROMPT,
  TEST_SSH_HOST_KEY,
  TEST_SSH_PUBLIC_KEY,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { loadPi } from "../../agent/pi.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import { SessionFormat, SpanOperation, SpanRecorder } from "./telemetry.ts";
import { PINNED_CONTEXT_TYPE } from "./session-entries.ts";

const SECRET = "test_native-scripted-key";
const NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PROVIDER_CALL_COUNT = 3;
const CALLS_BEFORE_FAILED_CHECK = 1;
const TRANSCRIPT_LENGTH_BEFORE = 3;
const SINGLE_TURN_BUDGET = 1;
const SINGLE_CALL_COUNT = 1;
const CONTENT = "written";
const PROJECT_PROMPT = "project prompt text";
const HOME_TEXT = "home file text";
const TOOL_RESULT = "toolResult";
const START_POLL_MS = 10;
const JUDGED = "judged";
const TRANSCRIPT_MESSAGES = 5;
const HEADER_LINES = 1;
const EMPTY_LINE = "";
const MESSAGE_ENTRY = "message";
const ASSISTANT_ROLE = "assistant";
const CHAT_OPERATION = "chat";
const CUSTOM_ENTRY = "custom";
const SESSION_HEADER = "session";
const NO_ENTRIES = 0;
const SPAN_ID_LENGTH = 16;
const WORK = renderWorkPrompt(SHIPPED_TEMPLATES, {
  node_id: NODE,
  revision: 1,
  content: {
    name: "work",
    requirement: "write files",
    criterion: "files exist",
    verifications: [],
  },
});
const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });

async function fixture(
  t: TestContext,
  script: Parameters<typeof scriptedProvider>[0],
  overrides: Partial<ExecutionSetup> = {},
  hostTools: HostTools = unusedHostTools,
  options: {
    method?: WorkerMethod;
    prepare?: (workspace: string, hostHome: string) => void;
    turnCheck?: (context: CancellationContext) => Promise<void>;
    intent?: ExecutionIntent;
    checkouts?: (workspace: string) => string[];
    sessionRoot?: false;
  } = {},
) {
  const setup = anthropicSetup(overrides);
  const workspace = temporary(t);
  const hostHome = temporary(t);
  options.prepare?.(workspace, hostHome);
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: SECRET,
  }));
  const context = new CancellationContext(background);
  t.after(() => context.cancel());
  const records: TelemetryRecord[] = [];
  const spans = new SpanRecorder(
    {
      execution_id: setup.execution_id,
      node_id: NODE,
      attempt: 1,
      trace_id: "a".repeat(32),
      root_span_id: "1".repeat(16),
    },
    "coder@1",
    { write: (batch) => records.push(...batch), flush: async () => {} },
  );
  const sessionRoot = options.sessionRoot === false ? undefined : temporary(t);
  const agent = await openNativeAgent({
    spans,
    sessionRoot,
    hostTools,
    setup,
    claim: {
      execution_id: setup.execution_id,
      node_id: NODE,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
    },
    intent: options.intent ?? ExecutionIntent.Implement,
    agent: setup.agents[0]!,
    credential: {
      credential_id: setup.agents[0]!.credential_id,
      provider_id: "anthropic",
      store: credentials,
    },
    budget: new ExecutionBudget({
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      resource_budget: setup.resource_budget,
    }),
    workspaceAgentFiles:
      (options.method ?? WorkerMethod.Steps) !== WorkerMethod.Evaluation,
    workspace,
    checkouts: options.checkouts?.(workspace) ?? [workspace],
    hostHome,
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context,
    turnCheck: options.turnCheck && (() => options.turnCheck!(context)),
  });
  t.after(() => agent.dispose());
  return {
    agent,
    provider,
    workspace,
    context,
    records,
    sessionRoot,
    executionId: setup.execution_id,
    setupAgent: setup.agents[0]!,
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;

function sessionFiles(h: Harness): string[] {
  assert.ok(h.sessionRoot);
  const directory = join(h.sessionRoot, h.executionId);
  return readdirSync(directory).map((name) => join(directory, name));
}

function sessionLines(h: Harness): Record<string, unknown>[] {
  const [file] = sessionFiles(h);
  assert.ok(file);
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== EMPTY_LINE)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function sessionMessages(h: Harness): unknown[] {
  return sessionLines(h)
    .slice(HEADER_LINES)
    .filter((entry) => entry.type === MESSAGE_ENTRY)
    .map((entry) => entry.message);
}

function sessionSpans(h: Harness) {
  return h.records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Session
      ? [record]
      : [],
  );
}

function sessionEnds(h: Harness) {
  return sessionSpans(h).filter((record) => record.end_time);
}

test("native software agent writes and runs bounded bash with execution credentials", async (t) => {
  const h = await fixture(t, [
    tool("write", { path: "written.txt", content: CONTENT }),
    tool("bash", { command: "printf shell > shell.txt" }),
    fauxAssistantMessage("done"),
  ]);
  await h.agent.prompt(WORK);
  assert.equal(readFileSync(join(h.workspace, "written.txt"), "utf8"), CONTENT);
  assert.ok(existsSync(join(h.workspace, "shell.txt")));
  assert.equal(h.provider.calls.length, PROVIDER_CALL_COUNT);
  assert.ok(h.provider.calls.every(({ apiKey }) => apiKey === SECRET));
  assert.ok(
    h.provider.calls.every(({ systemPrompt }) =>
      systemPrompt?.includes(SETUP_PROMPT),
    ),
  );
  assert.deepEqual(h.agent.composition, { selected: [], rejected: [] });
});

test("the agent.session span starts with the session attributes and its identity", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  const [start] = sessionSpans(h);
  assert.ok(start?.start_time);
  assert.equal(start.attributes?.["gen_ai.conversation.id"], start.span_id);
  assert.equal(start.parent_span_id, "1".repeat(SPAN_ID_LENGTH));
  const { agent_name, position, level, effective_configuration } = h.setupAgent;
  const attributes = start.attributes ?? {};
  const pi = await loadPi();
  const expected = {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.conversation.id": start.span_id,
    "gen_ai.agent.name": agent_name,
    "kanthord.agent.name": agent_name,
    "kanthord.agent.chain_position": position,
    "kanthord.agent.chain_level": level,
    "gen_ai.request.model": effective_configuration.model_identifier,
    "kanthord.session.format": SessionFormat.Pi,
    "kanthord.session.format_version": pi.CURRENT_SESSION_VERSION,
  };
  const exact = Object.fromEntries(
    Object.keys(expected).map((key) => [key, attributes[key]]),
  );
  assert.deepEqual(exact, expected);
});

test("pi persists the session to a file of the execution directory named by the span identity", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  const [start] = sessionSpans(h);
  const files = sessionFiles(h);
  assert.equal(files.length, SINGLE_CALL_COUNT);
  assert.ok(files[0]?.endsWith(`_${start?.span_id}.jsonl`));
  const [header] = sessionLines(h);
  assert.equal(header?.type, SESSION_HEADER);
  assert.equal(header?.id, start?.span_id);
});

test("dispose ends the agent.session span once with the entry count", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  h.agent.dispose();
  const [end] = sessionEnds(h);
  assert.equal(sessionEnds(h).length, SINGLE_CALL_COUNT);
  assert.equal(end?.status, SpanStatus.Ok);
  assert.ok(
    Number(end?.attributes?.["kanthord.session.entry_count"]) > NO_ENTRIES,
  );
  h.agent.dispose();
  assert.equal(sessionEnds(h).length, SINGLE_CALL_COUNT);
});

test("closeTrace ends the agent.session span with its status and dispose writes nothing more", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Error);
  h.agent.closeTrace(SpanStatus.Ok);
  h.agent.dispose();
  assert.equal(sessionEnds(h).length, SINGLE_CALL_COUNT);
  assert.equal(sessionEnds(h)[0]?.status, SpanStatus.Error);
});

test("without a session root pi writes no session file", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    {},
    unusedHostTools,
    { sessionRoot: false },
  );
  await h.agent.prompt(WORK);
  assert.equal(h.sessionRoot, undefined);
  assert.equal(
    sessionSpans(h)[0]?.attributes?.["kanthord.session.format"],
    SessionFormat.Pi,
  );
  assert.deepEqual(
    readdirSync(h.workspace, { recursive: true, encoding: "utf8" }).filter(
      (name) => name.endsWith(".jsonl"),
    ),
    [],
  );
});

function repositoryOf(
  workingLayer: Partial<typeof WORKING_LAYER_ALL_ON>,
  projectPrompt: string | null = PROJECT_PROMPT,
) {
  return {
    binding_id: createIdentity("binding"),
    name: "repo",
    address: "git@github.com:owner/repo.git",
    ssh_host_key: TEST_SSH_HOST_KEY,
    resource_identity: "github:kanthorlabs/engine",
    ssh_public_key: TEST_SSH_PUBLIC_KEY,
    strategy: { base_branch: "main" },
    project_prompt: projectPrompt,
    working_layer: { ...WORKING_LAYER_ALL_ON, ...workingLayer },
    environment: null,
  };
}

const WORKSPACE_FILES = [
  ["AGENTS.md", "agents text"],
  ["AGENTS.local.md", "agents local text"],
  ["CLAUDE.md", "claude text"],
  ["CLAUDE.local.md", "claude local text"],
] as const;

function writeFiles(workspace: string, hostHome: string) {
  for (const [name, text] of WORKSPACE_FILES)
    writeFileSync(join(workspace, name), text);
  mkdirSync(join(hostHome, ".agents"));
  writeFileSync(join(hostHome, ".agents/AGENTS.md"), HOME_TEXT);
}

const callText = (h: Awaited<ReturnType<typeof fixture>>) =>
  JSON.stringify(h.provider.calls.map(({ messages }) => messages));

test("native agent composes only the switched-on workspace files and the project prompt", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    {
      repositories: [
        repositoryOf({ agents_local_md: false, claude_md: false }),
      ],
    },
    unusedHostTools,
    { prepare: writeFiles },
  );
  await h.agent.prompt(WORK);
  const text = callText(h);
  assert.ok(text.includes("agents text"));
  assert.ok(text.includes("claude local text"));
  assert.ok(text.includes(PROJECT_PROMPT));
  assert.ok(!text.includes("agents local text"));
  assert.ok(!text.includes('"claude text'));
  assert.ok(!text.includes(HOME_TEXT));
  assert.ok(
    h.provider.calls.every(
      ({ systemPrompt }) => !systemPrompt?.includes(HOME_TEXT),
    ),
  );
  assert.deepEqual(
    h.agent.composition.selected.map(({ source }) => source),
    [
      `file ${join(h.workspace, "AGENTS.md")}`,
      `file ${join(h.workspace, "CLAUDE.local.md")}`,
      "database project prompt",
    ],
  );
  assert.ok(
    h.agent.composition.selected.every(({ digest }) =>
      /^[a-f0-9]{64}$/.test(digest),
    ),
  );
});

function sessionEntries(h: Harness) {
  return h.records.flatMap((record) =>
    record.kind === RecordKind.SessionEntry ? [record] : [],
  );
}

test("a prompt writes every pi entry as a session_entry record with the pinned context first", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    { repositories: [repositoryOf({})] },
    unusedHostTools,
    { prepare: writeFiles },
  );
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Ok);
  const [start] = sessionSpans(h);
  const entries = sessionEntries(h);
  assert.deepEqual(
    entries.map(({ sequence }) => sequence),
    entries.map((_, index) => index + 1),
  );
  assert.ok(entries.every(({ session_id }) => session_id === start?.span_id));
  assert.deepEqual(
    entries.slice(0, 2).map(({ entry_type }) => entry_type),
    ["model_change", "thinking_level_change"],
  );
  const customs = entries.filter(
    ({ entry_type }) => entry_type === CUSTOM_ENTRY,
  );
  assert.equal(entries[2], customs[0]);
  assert.ok(
    customs.every(({ entry }) => entry.customType === PINNED_CONTEXT_TYPE),
  );
  const parts = customs.map(
    ({ entry }) => entry.data as Record<string, unknown>,
  );
  assert.deepEqual(parts[0], { part: "system_prompt", text: SETUP_PROMPT });
  const layers = parts.slice(1);
  assert.ok(layers.length >= WORKSPACE_FILES.length);
  assert.deepEqual(
    layers.map(({ part, index }) => [part, index]),
    layers.map((_, index) => ["layer", index + 1]),
  );
  assert.ok(String(layers.at(-1)?.text).includes(PROJECT_PROMPT));
  assert.equal(
    new Set(entries.map(({ entry_id }) => entry_id)).size,
    entries.length,
  );
});

test("a turn end names the assistant session entry of the turn and links the session", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Ok);
  const [session] = sessionSpans(h);
  const turns = h.records.flatMap((record) =>
    record.kind === RecordKind.Span && record.operation === SpanOperation.Turn
      ? [record]
      : [],
  );
  const start = turns.find((record) => record.start_time);
  const end = turns.find((record) => record.end_time);
  assert.equal(start?.attributes?.["gen_ai.conversation.id"], session?.span_id);
  assert.equal(start?.attributes?.["gen_ai.operation.name"], CHAT_OPERATION);
  const assistant = sessionEntries(h).find(
    ({ entry_id }) =>
      entry_id === end?.attributes?.["kanthord.session.entry_id"],
  );
  assert.equal(assistant?.entry_type, MESSAGE_ENTRY);
  assert.equal(
    (assistant?.entry.message as { role: string }).role,
    ASSISTANT_ROLE,
  );
  const message = assistant?.entry.message as {
    usage: { input: number; cacheRead: number; cacheWrite: number };
  };
  assert.equal(
    end?.attributes?.["gen_ai.usage.input_tokens"],
    message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
  );
});

test("the entry_count of the agent.session end equals the count of sent entries", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Ok);
  const [end] = sessionEnds(h);
  const sent = sessionEntries(h).length;
  assert.ok(sent > NO_ENTRIES);
  assert.equal(end?.attributes?.["kanthord.session.entry_count"], sent);
});

test("a session entry record never holds the credential secret", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage(`key ${SECRET}`)]);
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Ok);
  assert.ok(sessionEntries(h).length > NO_ENTRIES);
  assert.ok(!JSON.stringify(sessionEntries(h)).includes(SECRET));
  assert.ok(JSON.stringify(sessionEntries(h)).includes("key [redacted]"));
});

async function composesOnePartPerBinding(
  t: TestContext,
  intent: ExecutionIntent,
) {
  const names = ["first", "second"];
  const checkoutsOf = (workspace: string) =>
    names.map((name) => join(workspace, "checkouts", name));
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    {
      repositories: names.map((name) => ({
        ...repositoryOf({}, `${name} project prompt`),
        name,
      })),
    },
    unusedHostTools,
    {
      intent,
      checkouts: checkoutsOf,
      prepare: (workspace) => {
        for (const [index, directory] of checkoutsOf(workspace).entries()) {
          mkdirSync(directory, { recursive: true });
          writeFileSync(join(directory, "AGENTS.md"), `${names[index]} agents`);
        }
      },
    },
  );
  await h.agent.prompt(WORK);
  const text = callText(h);
  for (const name of names) {
    assert.ok(text.includes(`${name} agents`));
    assert.ok(text.includes(`${name} project prompt`));
  }
  assert.deepEqual(
    h.agent.composition.selected.map(({ owner, source }) => [owner, source]),
    checkoutsOf(h.workspace).flatMap((directory, index) => [
      [
        `repository binding ${names[index]}`,
        `file ${join(directory, "AGENTS.md")}`,
      ],
      [`repository binding ${names[index]}`, "database project prompt"],
    ]),
  );
}

test("an examine node composes one project prompt part for each repository binding in binding order", (t) =>
  composesOnePartPerBinding(t, ExecutionIntent.Examine));

test("two bindings compose two parts in binding order from their checkouts", (t) =>
  composesOnePartPerBinding(t, ExecutionIntent.Implement));

test("the work prompt lists both repositories", async (t) => {
  const current = task("both", "true");
  const h = await implementFixture(t, [current], [], undefined, ["api", "web"]);
  const text = taskWork(h, current).text;
  assert.ok(
    text.includes(
      "## Repositories\n\nRepository api: directory `api`, base branch `main`\nRepository web: directory `web`, base branch `main`",
    ),
  );
  const single = await implementFixture(t, [current], []);
  assert.equal(
    taskWork(single, current).text.includes("## Repositories"),
    false,
  );
});

test("native agent rejects a working file that leaves the workspace and records the reason", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    { repositories: [repositoryOf({}, null)] },
    unusedHostTools,
    {
      prepare: (workspace, hostHome) => {
        writeFiles(workspace, hostHome);
        rmSync(join(workspace, "AGENTS.md"));
        symlinkSync(
          join(hostHome, ".agents/AGENTS.md"),
          join(workspace, "AGENTS.md"),
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  assert.deepEqual(
    h.agent.composition.rejected.map(({ reason }) => reason),
    ["outside_workspace"],
  );
  assert.ok(!callText(h).includes(HOME_TEXT));
});

test("an evaluation takes the project prompt only and reads no workspace file", async (t) => {
  const h = await fixture(
    t,
    [fauxAssistantMessage("done")],
    { repositories: [repositoryOf({})] },
    unusedHostTools,
    {
      method: WorkerMethod.Evaluation,
      prepare: (workspace, hostHome) => {
        writeFiles(workspace, hostHome);
        rmSync(join(workspace, "CLAUDE.md"));
        symlinkSync(
          join(hostHome, ".agents/AGENTS.md"),
          join(workspace, "CLAUDE.md"),
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  const text = callText(h);
  assert.ok(text.includes(PROJECT_PROMPT));
  for (const [, content] of WORKSPACE_FILES) assert.ok(!text.includes(content));
  assert.deepEqual(
    h.agent.composition.selected.map(({ source }) => source),
    ["database project prompt"],
  );
  assert.deepEqual(h.agent.composition.rejected, []);
});

test("native reviewer refuses a scripted write tool", async (t) => {
  const h = await fixture(
    t,
    [
      tool("write", { path: "forbidden.txt", content: CONTENT }),
      fauxAssistantMessage("done"),
    ],
    {
      worker_name: "reviewer@1",
      agents: [anthropicAgent({ agent_name: "re@1" })],
    },
  );
  await h.agent.prompt(WORK);
  assert.equal(existsSync(join(h.workspace, "forbidden.txt")), false);
  assert.ok(
    h.provider.calls.some(({ messages }) =>
      messages.some(
        (message) => message.role === TOOL_RESULT && message.isError,
      ),
    ),
  );
});

test("host upload is declared only for the software agent and validates arguments", async (t) => {
  const result = {
    evidence_id: "evidence_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    asset_id: "evidence_asset_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    uri: "s3://test-bucket/a.txt",
  };
  const paths: string[] = [];
  const hostTools: HostTools = {
    evidenceUpload: async (path) => {
      paths.push(path);
      return result;
    },
  };
  const h = await fixture(
    t,
    [
      tool("evidence-upload", { path: "a.txt" }),
      tool("evidence-upload", { path: "b.txt", extra: true }),
      fauxAssistantMessage("done"),
    ],
    {},
    hostTools,
  );
  await h.agent.prompt(WORK);
  assert.deepEqual(paths, ["a.txt"]);
  const messages = sessionMessages(h) as {
    role: string;
    isError?: boolean;
    details?: unknown;
  }[];
  assert.ok(
    messages.some(
      (message) =>
        message.role === TOOL_RESULT &&
        !message.isError &&
        JSON.stringify(message.details) === JSON.stringify(result),
    ),
  );
  assert.ok(
    messages.some((message) => message.role === TOOL_RESULT && message.isError),
  );
  const reviewer = await fixture(
    t,
    [tool("evidence-upload", { path: "c.txt" }), fauxAssistantMessage("done")],
    {
      worker_name: "reviewer@1",
      agents: [anthropicAgent({ agent_name: "re@1" })],
    },
    hostTools,
  );
  await reviewer.agent.prompt(WORK);
  assert.deepEqual(paths, ["a.txt"]);
});

test("host upload rejection becomes a tool error without error details", async (t) => {
  const message = "test_upload_refused";
  const h = await fixture(
    t,
    [tool("evidence-upload", { path: "a.txt" }), fauxAssistantMessage("done")],
    {},
    {
      evidenceUpload: async () => {
        throw Object.assign(
          new Diagnostic("worker.evidence_upload.path_refused", message),
          {
            details: { putUrl: "test_private_url" },
          },
        );
      },
    },
  );
  await h.agent.prompt(WORK);
  const records = JSON.stringify(sessionMessages(h));
  assert.ok(records.includes(message));
  assert.ok(!records.includes("test_private_url"));
  assert.ok(records.includes('"isError":true'));
});

test("native turn budget aborts after the first tool turn", async (t) => {
  const h = await fixture(
    t,
    [
      tool("write", { path: "one.txt", content: CONTENT }),
      tool("write", { path: "two.txt", content: CONTENT }),
      fauxAssistantMessage("done"),
    ],
    { resource_budget: { turns: SINGLE_TURN_BUDGET, wall_time_ms: 60000 } },
  );
  await h.agent.prompt(WORK);
  assert.equal(h.provider.calls.length, SINGLE_CALL_COUNT);
  assert.equal(h.agent.budget.exhausted(), true);
  assert.equal(existsSync(join(h.workspace, "two.txt")), false);
});

test("native parent cancellation aborts an active tool and disposal refuses reuse", async (t) => {
  const h = await fixture(t, [
    tool("bash", { command: "touch started; sleep 30" }),
    fauxAssistantMessage("unexpected"),
  ]);
  const pending = h.agent.prompt(WORK);
  while (!existsSync(join(h.workspace, "started")))
    await setTimeout(START_POLL_MS, undefined, { signal: t.signal });
  assert.ok(existsSync(join(h.workspace, "started")));
  h.context.cancel();
  await pending;
  assert.equal(h.provider.calls.length, SINGLE_CALL_COUNT);
  h.agent.dispose();
  await assert.rejects(h.agent.prompt(WORK));
  await assert.rejects(h.agent.instruct(WORK, "judge"));
});

test("native instructions preserve pinned work and persist the session and last text", async (t) => {
  const h = await fixture(t, [
    fauxAssistantMessage("work done"),
    fauxAssistantMessage(JUDGED),
  ]);
  assert.equal(h.agent.lastText(), undefined);
  await h.agent.prompt(WORK);
  const before = sessionMessages(h);
  await h.agent.instruct(WORK, "judge");
  const call = h.provider.calls.at(-1)!;
  const messages = JSON.stringify(call.messages);
  assert.equal(
    messages.split(JSON.stringify(WORK.text).slice(1, -1)).length - 1,
    SINGLE_CALL_COUNT,
  );
  assert.deepEqual(call.messages.at(-1)?.content, [
    { type: "text", text: "judge" },
  ]);
  assert.equal(h.agent.lastText(), JUDGED);
  assert.equal(before.length, TRANSCRIPT_LENGTH_BEFORE);
  assert.equal(sessionMessages(h).length, TRANSCRIPT_MESSAGES);
  assert.deepEqual(
    sessionMessages(h).map((message) => (message as { role: string }).role),
    ["system", "user", "assistant", "user", "assistant"],
  );
});

test("a failed turn check ends the prompt before the next model call", async (t) => {
  const h = await fixture(
    t,
    [
      tool("write", { path: "first.txt", content: CONTENT }),
      tool("write", { path: "second.txt", content: CONTENT }),
      fauxAssistantMessage("done"),
    ],
    {},
    unusedHostTools,
    {
      turnCheck: async (context) => {
        context.cancel();
        throw new Error("claim revoked");
      },
    },
  );
  await h.agent.prompt(WORK);
  assert.ok(existsSync(join(h.workspace, "first.txt")));
  assert.equal(existsSync(join(h.workspace, "second.txt")), false);
  assert.equal(h.provider.calls.length, CALLS_BEFORE_FAILED_CHECK);
});

const AUTH_FAILED = "llm.auth.failed";
const REFRESHED_DETAIL =
  "Error: Authentication failed [redacted] [redacted] [redacted]";
const AUTH_FAILED_DETAIL = "Error: Authentication failed [redacted] [redacted]";

test("a thrown prompt error stops the run with its cause text and the OAuth tokens removed", async () => {
  const access = "short_access_1";
  const refresh = "short_refresh_1";
  const store = new InMemoryCredentialStore();
  await store.modify("anthropic", async () => ({
    type: "oauth",
    access,
    refresh,
    expires: Date.now() + 60000,
  }));
  const credential = {
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    store,
  };
  const stopped = await promptStop(
    new CodedError(AUTH_FAILED, `Authentication failed ${access} ${refresh}`),
    credentialRedaction(credential),
  );
  assert.ok(stopped instanceof ExecutionStop);
  assert.equal(stopped.reason, EndReason.OperationFailed);
  assert.equal(stopped.code, AUTH_FAILED);
  assert.equal(stopped.detail, AUTH_FAILED_DETAIL);
  const earlier = new ExecutionStop(EndReason.Revoked, null);
  assert.equal(
    await promptStop(earlier, credentialRedaction(credential)),
    earlier,
  );
});

test("the stop detail removes the OAuth tokens from before and after a refresh", async () => {
  const store = new InMemoryCredentialStore();
  const tokens = (access: string, refresh: string) => async () => ({
    type: "oauth" as const,
    access,
    refresh,
    expires: Date.now() + 60000,
  });
  await store.modify("anthropic", tokens("old_access_1", "old_refresh_1"));
  const secrets = credentialRedaction({
    credential_id: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    provider_id: "anthropic",
    store,
  });
  await secrets();
  await store.modify("anthropic", tokens("new_access_1", "new_refresh_1"));
  const stopped = await promptStop(
    new CodedError(
      AUTH_FAILED,
      "Authentication failed old_access_1 new_access_1 new_refresh_1",
    ),
    secrets,
  );
  assert.ok(stopped instanceof ExecutionStop);
  assert.equal(stopped.detail, REFRESHED_DETAIL);
});
