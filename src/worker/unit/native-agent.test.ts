import { ExecutionBudget } from "./budget.ts";
import assert from "node:assert/strict";
import {
  declareAffected,
  implementFixture,
  nextExecution,
  task,
  unusedHostTools,
} from "./test-support.ts";
import { taskWork } from "./steps-implement.ts";
import { nodeWork } from "./base-refresh.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background, CancellationContext } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import {
  credentialRedaction,
  openNativeAgent,
  promptStop,
} from "./native-agent.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { CodedError } from "../../kernel/errors.ts";
import { ExecutionIntent } from "../contract.ts";
import type { ExecutionSetup, HostTools } from "../contract.ts";
import { digest, renderWorkPrompt } from "../../agent/prompt-composer.ts";
import { PromptTemplate } from "../../agent/contract.ts";
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
const TWO_SENDS = 2;
const CONTENT = "written";
const USER_ROLE = "user";
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
const TOOL_CALL_PART = "toolCall";
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
    prepare?: (workspace: string, hostHome: string) => void;
    turnCheck?: (context: CancellationContext) => Promise<void>;
    intent?: ExecutionIntent;
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
    workspace,
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
    "kanthord.agent.reasoning_effort": effective_configuration.reasoning_effort,
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

function repositoryOf() {
  return {
    binding_id: createIdentity("binding"),
    name: "repo",
    address: "git@github.com:owner/repo.git",
    ssh_host_key: TEST_SSH_HOST_KEY,
    resource_identity: "github:kanthorlabs/engine",
    ssh_public_key: TEST_SSH_PUBLIC_KEY,
    strategy: { base_branch: "main" },
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

test("the worker pins only the work prompt and reads no instruction file for every intent", async (t) => {
  for (const intent of Object.values(ExecutionIntent)) {
    const h = await fixture(
      t,
      [fauxAssistantMessage("done")],
      { repositories: [repositoryOf()] },
      unusedHostTools,
      { intent, prepare: writeFiles },
    );
    await h.agent.prompt(WORK);
    const work = JSON.stringify(WORK.text).slice(1, -1);
    for (const call of h.provider.calls) {
      assert.equal(call.systemPrompt?.includes(HOME_TEXT), false);
      assert.deepEqual(
        call.messages.flatMap((message) =>
          message.role === USER_ROLE ? [JSON.stringify(message.content)] : [],
        ),
        [JSON.stringify([{ type: "text", text: WORK.text }])],
      );
    }
    const text = callText(h);
    assert.ok(text.includes(work));
    for (const [, content] of WORKSPACE_FILES)
      assert.equal(text.includes(content), false);
    assert.equal(text.includes(HOME_TEXT), false);
  }
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
    { repositories: [repositoryOf()] },
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
  assert.deepEqual(
    customs.map(({ entry }) => entry.data),
    [{ part: "system_prompt", text: SETUP_PROMPT }],
  );
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

test("a tool start names the stored assistant entry that holds its call", async (t) => {
  const h = await fixture(t, [
    tool("write", { path: "written.txt", content: CONTENT }),
    fauxAssistantMessage("done"),
  ]);
  await h.agent.prompt(WORK);
  h.agent.closeTrace(SpanStatus.Ok);
  const start = h.records.find(
    (record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Tool &&
      record.start_time,
  );
  const callId = (start as { attributes?: Record<string, unknown> })
    .attributes?.["gen_ai.tool.call.id"];
  const entryId = (start as { attributes?: Record<string, unknown> })
    .attributes?.["kanthord.session.entry_id"];
  assert.ok(callId);
  const assistant = sessionEntries(h).find(
    ({ entry_id }) => entry_id === entryId,
  );
  assert.equal(assistant?.entry_type, MESSAGE_ENTRY);
  const message = assistant?.entry.message as {
    role: string;
    content: { type: string; id?: string }[];
  };
  assert.equal(message.role, ASSISTANT_ROLE);
  assert.ok(
    message.content.some(
      (part) => part.type === TOOL_CALL_PART && part.id === callId,
    ),
  );
});

function turnStarts(h: Harness) {
  return h.records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Turn &&
    record.start_time
      ? [record.attributes]
      : [],
  );
}

test("a prompt send records the work template on its turn start", async (t) => {
  const h = await fixture(t, [fauxAssistantMessage("done")]);
  await h.agent.prompt(WORK);
  const [start] = turnStarts(h);
  assert.equal(start?.["kanthord.prompt.template"], PromptTemplate.Work);
  assert.equal(
    start?.["kanthord.prompt.template.digest"],
    digest(SHIPPED_TEMPLATES[PromptTemplate.Work]),
  );
  assert.equal(start?.["kanthord.prompt.work.digest"], WORK.digest);
});

test("an instruct send records the template that it names on its turn start", async (t) => {
  const h = await fixture(t, [
    fauxAssistantMessage("done"),
    fauxAssistantMessage("repaired"),
  ]);
  await h.agent.prompt(WORK);
  await h.agent.instruct(WORK, "repair", PromptTemplate.Repair);
  const starts = turnStarts(h);
  assert.equal(starts.length, TWO_SENDS);
  assert.equal(starts[1]?.["kanthord.prompt.template"], PromptTemplate.Repair);
  assert.equal(
    starts[1]?.["kanthord.prompt.template.digest"],
    digest(SHIPPED_TEMPLATES[PromptTemplate.Repair]),
  );
  assert.equal(starts[1]?.["kanthord.prompt.work.digest"], WORK.digest);
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

const AFFECTED_COMMAND = "pnpm --silent run test:affected";
const AFFECTED_SECTION = "## Affected tests";
const BLANK_COMMAND = " ";
const GATE_FILE = "package.json";
const GATE_FILES_RULE =
  "Change a gate file only when the requirement names it.";

test("the node work and the task work name the affected command of a declaring checkout", async (t) => {
  const current = task("affected", "true");
  const first = await implementFixture(t, [current], [], undefined, [
    "api",
    "web",
  ]);
  assert.deepEqual(first.affectedTests, []);
  await declareAffected(first, t, AFFECTED_COMMAND);
  const h = await nextExecution(t, first, []);
  assert.deepEqual(h.affectedTests, [
    { name: "api", command: AFFECTED_COMMAND, gate_files: [] },
  ]);
  const section = `${AFFECTED_SECTION}\n\nRepository api: affected tests \`${AFFECTED_COMMAND}\`\nKanthorD runs each command`;
  assert.ok(taskWork(h, current).text.includes(section));
  assert.ok(nodeWork(h).text.includes(section));
  assert.ok(!first.affectedTests.length);
  assert.ok(!taskWork(first, current).text.includes(AFFECTED_SECTION));
});

test("the task work names the gate files of a declaring checkout", async (t) => {
  const current = task("gated", "true");
  const first = await implementFixture(t, [current], [], undefined, ["api"]);
  await declareAffected(first, t, AFFECTED_COMMAND, [GATE_FILE]);
  const h = await nextExecution(t, first, []);
  assert.deepEqual(h.affectedTests[0]?.gate_files, [GATE_FILE]);
  assert.ok(
    taskWork(h, current).text.includes(
      `Gate files of repository api: \`${GATE_FILE}\`. ${GATE_FILES_RULE}`,
    ),
  );
});

test("an invalid affected declaration gives no entry and no stop", async (t) => {
  const current = task("invalid", "true");
  const first = await implementFixture(t, [current], []);
  await declareAffected(first, t, BLANK_COMMAND);
  const h = await nextExecution(t, first, []);
  assert.deepEqual(h.affectedTests, []);
  assert.ok(!taskWork(h, current).text.includes(AFFECTED_SECTION));
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
  await assert.rejects(
    h.agent.instruct(WORK, "judge", PromptTemplate.Evaluation),
  );
});

test("native instructions preserve pinned work and persist the session and last text", async (t) => {
  const h = await fixture(t, [
    fauxAssistantMessage("work done"),
    fauxAssistantMessage(JUDGED),
  ]);
  assert.equal(h.agent.lastText(), undefined);
  await h.agent.prompt(WORK);
  const before = sessionMessages(h);
  await h.agent.instruct(WORK, "judge", PromptTemplate.Evaluation);
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
