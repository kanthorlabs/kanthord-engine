import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  AgentSession,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import {
  mintRunKey,
  SpanOperation,
  SpanRecorder,
  type TelemetrySink,
  telemetrySpanId,
} from "./telemetry.ts";
import { AgentErrorType, traceAgent } from "./agent-telemetry.ts";
import type { TurnPrompt } from "./native-agent.ts";
import type { ToolTimeout } from "./tool-table.ts";
import {
  environmentDigestsOf,
  GitStep,
  taskEnd,
  taskFailure,
  taskSpan,
  VerificationContext,
  VerificationKind,
  verificationObserver,
  type VerificationScope,
  withinGit,
} from "./method-telemetry.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { noProgressDetail, NoProgressRule } from "./progress-rule.ts";
import type { TaskContent } from "../../mission/contract.ts";
import {
  CommandEnd,
  type CommandRun,
  VerificationClass,
} from "./verification.ts";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ChainLevel, PromptTemplate } from "../../agent/contract.ts";

const CLAIM = {
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 1,
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
};
const WORKER = "coder@1";
const SPAN_ID = /^[0-9a-f]{16}$/;
const LONG_TEXT_CHARACTERS = 20000;
const TWO_PARTS = 2;
const FAILED = "failed";
const INPUT_TOKENS = 10;
const SPLIT_BEFORE_PAIR = 14999;
const ONE_FAULT = 1;
const NO_PROGRESS_COUNT = 2;
const FAILED_EXIT = 1;
const TWO_COMMANDS = 2;
const NO_SENT = 0;
const ONE_ENTRY = 1;
const TWO_ENTRIES = 2;
const ONE_UNSUBSCRIBE = 1;
const TOOL_CALL = "call_1";
const TWO_REFRESHES = 2;
const NO_TOOL_SPANS = 0;
const SECOND_POSITION = 1;
const SESSION_ID = "2".repeat(16);
const CREDENTIAL_SECRET = "test_tracer_credential_secret";
const REFRESHED_SECRET = "test_tracer_refreshed_secret";
const TRACING = {
  sessionId: SESSION_ID,
  secrets: [] as readonly string[],
  refreshSecrets: async (): Promise<readonly string[]> => [],
  processes: { take: () => undefined, takeTimeout: () => undefined },
  promptOf: (): TurnPrompt | null => null,
};
const MODEL = "glm-test-model";
const OUTCOME_OK = "ok";
const OUTCOME_ERROR = "error";
const RATE_LIMITED = "rate_limited";
const LAST_ASSISTANT_ENTRY = "00000004";
const FIRST_ENTRY = "00000001";
const EFFECTIVE_CONFIGURATION = {
  agent_provider: "zai",
  provider: "zai",
  credential: "credential_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  model_identifier: MODEL,
  reasoning_effort: "off",
} as const;
const ENABLEMENT_ID = "agent_enablement_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKER_BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const TRACED_AGENT = {
  agent_name: "swe@1",
  enablement_id: ENABLEMENT_ID,
  worker_binding_id: WORKER_BINDING_ID,
  position: 0,
  level: ChainLevel.Enablement,
  effective_configuration: EFFECTIVE_CONFIGURATION,
} as const;
const CACHE_READ = 30;
const CACHE_WRITE = 5;
const OUTPUT_TOKENS = 2;
const COST_USD = 0.25;
const MESSAGE_DURATION_MS = 1234;
const TURN_ATTRIBUTES = [
  "gen_ai.conversation.id",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "kanthord.agent.chain_level",
  "kanthord.agent.chain_position",
  "kanthord.agent.name",
  "kanthord.agent_enablement.id",
  "kanthord.turn.index",
  "kanthord.worker_binding.id",
];
const TURN_END_ATTRIBUTES = [
  "gen_ai.provider.name",
  "gen_ai.response.finish_reasons",
  "gen_ai.response.model",
  "gen_ai.usage.cache_creation.input_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "kanthord.session.entry_id",
  "kanthord.turn.model_duration_ms",
  "kanthord.usage.cost_usd",
];
const TOOL_END_ATTRIBUTES = [
  "kanthord.tool.duration_ms",
  "kanthord.tool.outcome",
];
function assistantMessage(fields: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: "openai-completions",
    provider: "zai",
    model: MODEL,
    stopReason: "stop",
    usage: {
      input: INPUT_TOKENS,
      output: OUTPUT_TOKENS,
      cacheRead: CACHE_READ,
      cacheWrite: CACHE_WRITE,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: COST_USD,
      },
    },
    timestamp: 1,
    ...fields,
  };
}

function textRecordsOf(records: TelemetryRecord[]) {
  return records.filter((record) => record.kind === RecordKind.Text);
}

function endOf(records: TelemetryRecord[], operation: SpanOperation) {
  return spanRecords(records).find(
    (record) => record.operation === operation && record.end_time,
  );
}

function startOf(records: TelemetryRecord[], operation: SpanOperation) {
  return spanRecords(records).find(
    (record) => record.operation === operation && record.start_time,
  );
}

const IDENTITY_NAMES = [
  "kanthord.execution.id",
  "kanthord.node.id",
  "kanthord.attempt",
  "kanthord.worker.name",
];

function identityOf(attributes: Record<string, unknown> | undefined) {
  return Object.fromEntries(
    IDENTITY_NAMES.map((name) => [name, attributes?.[name]]),
  );
}

function names(attributes: object | undefined): string[] {
  return Object.keys(attributes ?? {}).sort();
}

function recorder() {
  const records: TelemetryRecord[] = [];
  const sink: TelemetrySink = {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  };
  return { records, spans: new SpanRecorder(CLAIM, WORKER, sink) };
}

function scriptedSession() {
  const entries: SessionEntry[] = [];
  let listener: (event: unknown) => void = () => {};
  let unsubscribed = 0;
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {
        unsubscribed += 1;
      };
    },
    sessionManager: {
      getEntryCount: () => entries.length,
      getEntries: () => entries,
    },
  } as unknown as AgentSession;
  return {
    session,
    emit: (event: unknown) => listener(event),
    append: (fields: Record<string, unknown> = {}) => {
      const id = (entries.length + 1).toString(16).padStart(8, "0");
      entries.push({
        type: "custom",
        customType: "x",
        id,
        parentId: entries.at(-1)?.id ?? null,
        timestamp: "2026-01-02T03:04:05.000Z",
        ...fields,
      } as SessionEntry);
    },
    unsubscribed: () => unsubscribed,
  };
}

function entryRecords(records: TelemetryRecord[]) {
  return records.flatMap((record) =>
    record.kind === RecordKind.SessionEntry ? [record] : [],
  );
}

function spanRecords(records: TelemetryRecord[]) {
  return records.flatMap((record) =>
    record.kind === RecordKind.Span ? [record] : [],
  );
}

const RUN_KEY = "0a1b2c3d";
const OTHER_RUN_KEY = "4e5f6a7b";
const QUIET_SINK: TelemetrySink = { write: () => {}, flush: async () => {} };

test("one recorder gives one identity to one key every time", () => {
  const { spans } = recorder();
  const first = spans.spanIdOf("phase:start");
  assert.match(first, SPAN_ID);
  assert.equal(first, spans.spanIdOf("phase:start"));
  assert.notEqual(first, spans.spanIdOf("phase:tasks"));
});

test("two recorders with two run keys give two identities to one key", () => {
  const first = new SpanRecorder(CLAIM, WORKER, QUIET_SINK, RUN_KEY);
  const second = new SpanRecorder(CLAIM, WORKER, QUIET_SINK, OTHER_RUN_KEY);
  assert.notEqual(
    first.spanIdOf("phase:start"),
    second.spanIdOf("phase:start"),
  );
});

test("a recorder with a run key hashes the execution, the run key and the key", () => {
  const spans = new SpanRecorder(CLAIM, WORKER, QUIET_SINK, RUN_KEY);
  assert.equal(
    spans.spanIdOf("turn:1"),
    telemetrySpanId(CLAIM.execution_id, RUN_KEY, "turn:1"),
  );
});

test("a minted run key holds 8 lower-case hexadecimal characters", () => {
  assert.match(mintRunKey(), /^[0-9a-f]{8}$/);
  assert.throws(() => new SpanRecorder(CLAIM, WORKER, QUIET_SINK, "NOT-A-KEY"));
});

test("spanIdOf equals the span_id of the start record of that key", () => {
  const { records, spans } = recorder();
  spans.start({ key: "phase:start", operation: SpanOperation.Phase });
  const started = spanRecords(records).find((record) => record.start_time);
  assert.equal(spans.spanIdOf("phase:start"), started?.span_id);
});

test("a nested span names the enclosing span as its parent", async () => {
  const { records, spans } = recorder();
  const outer = await spans.within(
    { key: "phase:tasks", operation: SpanOperation.Phase },
    async (outerId) => {
      await spans.within(
        { key: "task:1", operation: SpanOperation.Task },
        async () => {},
      );
      return outerId;
    },
  );
  const written = spanRecords(records);
  const inner = written.find(
    (record) => record.operation === SpanOperation.Task,
  );
  assert.equal(inner?.parent_span_id, outer);
  assert.equal(written[0]?.parent_span_id, CLAIM.root_span_id);
  assert.equal(written[0]?.attributes?.["kanthord.worker.name"], WORKER);
  assert.equal(spans.current(), CLAIM.root_span_id);
});

test("a failed operation ends its span with Error and keeps the error", async () => {
  const { records, spans } = recorder();
  await assert.rejects(
    spans.within(
      { key: "phase:start", operation: SpanOperation.Phase },
      async () => {
        throw new Error(FAILED);
      },
    ),
    new RegExp(FAILED),
  );
  const end = spanRecords(records).find((record) => record.end_time);
  assert.equal(end?.status, SpanStatus.Error);
  assert.equal(spans.current(), CLAIM.root_span_id);
});

const NO_REVISIONS = 0;
const REVISION_COUNT_ATTRIBUTE = "kanthord.task.revision_count";

async function stoppedTaskEnd(stop: ExecutionStop) {
  const { records, spans } = recorder();
  await assert.rejects(
    spans.within(
      taskSpan(spans, { id: CLAIM.node_id } as TaskContent),
      async () => {
        throw stop;
      },
      (ended) => taskEnd(ended, NO_REVISIONS),
      (error) => taskFailure(error, NO_REVISIONS),
    ),
    stop,
  );
  return spanRecords(records).find((record) => record.end_time);
}

test("a no_progress stop ends the task span with the rule, the counts and the verification state", async () => {
  const end = await stoppedTaskEnd(
    new ExecutionStop(
      EndReason.NoProgress,
      null,
      noProgressDetail({
        rule: NoProgressRule.UnchangedRevision,
        count: NO_PROGRESS_COUNT,
        limit: NO_PROGRESS_COUNT,
        verification: {
          passed: false,
          ran: TWO_COMMANDS,
          exit_code: FAILED_EXIT,
          timed_out: false,
        },
      }),
    ),
  );
  assert.equal(end?.status, SpanStatus.Error);
  assert.deepEqual(end?.attributes, {
    "kanthord.stop.reason": EndReason.NoProgress,
    "kanthord.stop.rule": NoProgressRule.UnchangedRevision,
    "kanthord.stop.count": NO_PROGRESS_COUNT,
    "kanthord.stop.limit": NO_PROGRESS_COUNT,
    "kanthord.stop.verification.passed": false,
    [REVISION_COUNT_ATTRIBUTE]: NO_REVISIONS,
  });
});

test("another stop ends the task span with Error and no stop attribute", async () => {
  const end = await stoppedTaskEnd(
    new ExecutionStop(EndReason.OperationFailed, null, FAILED),
  );
  assert.equal(end?.status, SpanStatus.Error);
  assert.deepEqual(end?.attributes, {
    [REVISION_COUNT_ATTRIBUTE]: NO_REVISIONS,
  });
});

test("a git failure span text holds the diagnostic line and its rows", async () => {
  const cases = [
    {
      error: new Diagnostic("repository.git.push_failed", "push failed", {
        fields: [["path", "/x"]],
      }),
      text: "repository.git.push_failed: push failed\npath: /x",
    },
    {
      error: new Diagnostic("repository.git.push_failed", "push failed"),
      text: "repository.git.push_failed: push failed",
    },
  ];
  for (const { error, text } of cases) {
    const { records, spans } = recorder();
    await assert.rejects(
      withinGit(spans, GitStep.Push, async () => {
        throw error;
      }),
    );
    assert.deepEqual(
      records.flatMap((record) =>
        record.kind === RecordKind.Text ? [record.text] : [],
      ),
      [text],
    );
  }
});

const FIRST_DIGEST = "a".repeat(64);
const SECOND_DIGEST = "b".repeat(64);
const DIGEST_ATTRIBUTE = "environment.digest";
const PASSED_COMMAND: CommandRun = {
  result: { command: "true", exit_code: 0, signal: null, timed_out: false },
  output: "",
  end: CommandEnd.Exit,
};

async function verificationStart(digests: readonly string[]) {
  const { records, spans } = recorder();
  await verificationObserver(
    spans,
    null,
    digests,
    TASK_SCOPE,
  )(
    { command: "true", index: 0, run: 1, flaky_check: false },
    async () => PASSED_COMMAND,
  );
  return startOf(records, SpanOperation.Verification);
}

const CONTEXT_ATTRIBUTE = "kanthord.verification.context";
const OWNER_ATTRIBUTE = "kanthord.verification.owner_id";
const KIND_ATTRIBUTE = "kanthord.verification.kind";
const CLASS_ATTRIBUTE = "kanthord.verification.class";
const FLAKY_ATTRIBUTE = "kanthord.verification.flaky";
const TASK_OWNER = "task_owner";

const TASK_SCOPE = {
  context: VerificationContext.Task,
  ownerOf: () => TASK_OWNER,
};

async function observedVerification(
  scope: VerificationScope,
  flakyCheck: boolean,
  ran: CommandRun,
) {
  const { records, spans } = recorder();
  await verificationObserver(
    spans,
    null,
    [],
    scope,
  )(
    { command: "x", index: 0, run: 1, flaky_check: flakyCheck },
    async () => ran,
  );
  return {
    start: startOf(records, SpanOperation.Verification),
    end: endOf(records, SpanOperation.Verification),
  };
}

const FAILED_COMMAND: CommandRun = {
  result: { command: "x", exit_code: 1, signal: null, timed_out: false },
  output: "",
  end: CommandEnd.Exit,
};

test("a verification span records its context, its owner and the class of the run", async () => {
  const { start, end } = await observedVerification(
    TASK_SCOPE,
    false,
    PASSED_COMMAND,
  );
  assert.equal(
    start?.attributes?.[CONTEXT_ATTRIBUTE],
    VerificationContext.Task,
  );
  assert.equal(start?.attributes?.[OWNER_ATTRIBUTE], TASK_OWNER);
  assert.equal(start?.attributes?.[KIND_ATTRIBUTE], VerificationKind.Listed);
  assert.equal(end?.attributes?.[CLASS_ATTRIBUTE], VerificationClass.Pass);
  assert.equal(FLAKY_ATTRIBUTE in (end?.attributes ?? {}), false);
});

test("a verification span records no owner when the command has none", async () => {
  const { start } = await observedVerification(
    { context: VerificationContext.Node, ownerOf: () => null },
    false,
    PASSED_COMMAND,
  );
  assert.equal(
    start?.attributes?.[CONTEXT_ATTRIBUTE],
    VerificationContext.Node,
  );
  assert.equal(OWNER_ATTRIBUTE in (start?.attributes ?? {}), false);
});

test("a verification span records the flaky mark only on a passing flaky check", async () => {
  const passing = await observedVerification(TASK_SCOPE, true, PASSED_COMMAND);
  assert.equal(passing.end?.attributes?.[FLAKY_ATTRIBUTE], true);
  const failing = await observedVerification(TASK_SCOPE, true, FAILED_COMMAND);
  assert.equal(FLAKY_ATTRIBUTE in (failing.end?.attributes ?? {}), false);
  assert.equal(
    failing.end?.attributes?.[CLASS_ATTRIBUTE],
    VerificationClass.CodeFailure,
  );
});

test("a verification span records the one digest of the node", async () => {
  const start = await verificationStart([FIRST_DIGEST]);
  assert.equal(start?.attributes?.[DIGEST_ATTRIBUTE], FIRST_DIGEST);
});

test("a verification span joins the digests of two repositories with a comma in binding order", async () => {
  const start = await verificationStart([FIRST_DIGEST, SECOND_DIGEST]);
  assert.equal(
    start?.attributes?.[DIGEST_ATTRIBUTE],
    `${FIRST_DIGEST},${SECOND_DIGEST}`,
  );
});

test("a verification span records no digest attribute for no digest", async () => {
  const start = await verificationStart([]);
  assert.ok(start);
  assert.equal(DIGEST_ATTRIBUTE in (start.attributes ?? {}), false);
});

test("the digests of the repositories skip a repository with no environment", () => {
  assert.deepEqual(
    environmentDigestsOf([
      {
        environment: {
          source: EnvironmentSource.Repository,
          digest: FIRST_DIGEST,
        },
      },
      { environment: null },
      {
        environment: {
          source: EnvironmentSource.Stored,
          document: {},
          digest: SECOND_DIGEST,
        },
      },
    ]),
    [FIRST_DIGEST, SECOND_DIGEST],
  );
});

test("a long text splits into numbered parts", () => {
  const { records, spans } = recorder();
  const spanId = spans.start({
    key: "verification:1",
    operation: SpanOperation.Verification,
    texts: { output: "x".repeat(LONG_TEXT_CHARACTERS) },
  });
  const texts = records.filter((record) => record.kind === RecordKind.Text);
  assert.equal(texts.length, TWO_PARTS);
  assert.deepEqual(spanRecords(records)[0]?.text_ids, [
    `${spanId}:output.1`,
    `${spanId}:output.2`,
  ]);
});

test("the agent tracer writes a turn and its tool call without a text", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: { command: "npm test" },
  });
  scripted.emit({
    type: "tool_execution_end",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    result: { content: [{ type: "text", text: "1 passed" }] },
    isError: false,
  });
  scripted.append({
    type: "message",
    message: assistantMessage(),
  });
  scripted.emit({
    type: "turn_end",
    message: assistantMessage({
      responseModel: "glm-served",
      durationMs: MESSAGE_DURATION_MS,
    }),
    toolResults: [],
  });
  const turnStart = startOf(records, SpanOperation.Turn);
  const turnEnd = endOf(records, SpanOperation.Turn);
  const toolStart = startOf(records, SpanOperation.Tool);
  const toolEnd = endOf(records, SpanOperation.Tool);
  assert.equal(toolStart?.parent_span_id, turnEnd?.span_id);
  assert.deepEqual(turnStart?.attributes, {
    "kanthord.agent.name": TRACED_AGENT.agent_name,
    "kanthord.agent.chain_position": 0,
    "kanthord.agent.chain_level": ChainLevel.Enablement,
    "kanthord.turn.index": 1,
    "gen_ai.operation.name": "chat",
    "gen_ai.conversation.id": SESSION_ID,
    "gen_ai.request.model": MODEL,
    "kanthord.worker_binding.id": WORKER_BINDING_ID,
    "kanthord.agent_enablement.id": ENABLEMENT_ID,
    ...identityOf(turnStart?.attributes),
  });
  assert.equal(turnEnd?.status, SpanStatus.Ok);
  assert.deepEqual(turnEnd?.attributes, {
    "gen_ai.response.model": "glm-served",
    "gen_ai.provider.name": "zai",
    "gen_ai.usage.input_tokens": INPUT_TOKENS + CACHE_READ + CACHE_WRITE,
    "gen_ai.usage.output_tokens": OUTPUT_TOKENS,
    "gen_ai.usage.cache_read.input_tokens": CACHE_READ,
    "gen_ai.usage.cache_creation.input_tokens": CACHE_WRITE,
    "kanthord.usage.cost_usd": COST_USD,
    "gen_ai.response.finish_reasons": ["stop"],
    "kanthord.session.entry_id": "00000001",
    "kanthord.turn.model_duration_ms": MESSAGE_DURATION_MS,
  });
  assert.deepEqual(toolStart?.attributes, {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.conversation.id": SESSION_ID,
    "gen_ai.tool.name": "bash",
    "gen_ai.tool.call.id": TOOL_CALL,
    ...identityOf(toolStart?.attributes),
  });
  assert.deepEqual(names(toolEnd?.attributes), TOOL_END_ATTRIBUTES);
  assert.equal(toolEnd?.attributes?.["kanthord.tool.outcome"], OUTCOME_OK);
  assert.equal(toolEnd?.status, SpanStatus.Ok);
  assert.deepEqual(textRecordsOf(records), []);
  for (const span of spanRecords(records))
    assert.deepEqual(span.text_ids ?? [], []);
});

test("a tool start names the assistant entry that precedes it", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  const attributes = startOf(records, SpanOperation.Tool)?.attributes;
  assert.equal(attributes?.["kanthord.session.entry_id"], FIRST_ENTRY);
});

test("a tool start holds no entry id without an assistant entry after the turn start", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  const attributes = startOf(records, SpanOperation.Tool)?.attributes ?? {};
  assert.ok(!("kanthord.session.entry_id" in attributes));
});

const TURN_PROMPT: TurnPrompt = {
  template: PromptTemplate.Repair,
  template_digest: "a".repeat(64),
  work_digest: "b".repeat(64),
};

test("a turn start holds the prompt facts that promptOf answers", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, {
    ...TRACING,
    promptOf: () => TURN_PROMPT,
  });
  scripted.emit({ type: "turn_start" });
  const attributes = startOf(records, SpanOperation.Turn)?.attributes;
  assert.equal(attributes?.["kanthord.prompt.template"], TURN_PROMPT.template);
  assert.equal(
    attributes?.["kanthord.prompt.template.digest"],
    TURN_PROMPT.template_digest,
  );
  assert.equal(
    attributes?.["kanthord.prompt.work.digest"],
    TURN_PROMPT.work_digest,
  );
});

test("a turn start holds the worker binding id and the enablement id", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  const attributes = startOf(records, SpanOperation.Turn)?.attributes;
  assert.equal(attributes?.["kanthord.worker_binding.id"], WORKER_BINDING_ID);
  assert.equal(attributes?.["kanthord.agent_enablement.id"], ENABLEMENT_ID);
});

test("a turn start holds no enablement id when the agent has no pin", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(
    scripted.session,
    spans,
    { ...TRACED_AGENT, enablement_id: null },
    TRACING,
  );
  scripted.emit({ type: "turn_start" });
  const attributes = startOf(records, SpanOperation.Turn)?.attributes ?? {};
  assert.equal(attributes["kanthord.worker_binding.id"], WORKER_BINDING_ID);
  assert.ok(!("kanthord.agent_enablement.id" in attributes));
});

test("a turn start holds no prompt fact when promptOf answers null", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  const attributes = startOf(records, SpanOperation.Turn)?.attributes ?? {};
  assert.deepEqual(
    Object.keys(attributes).filter((name) =>
      name.startsWith("kanthord.prompt."),
    ),
    [],
  );
});

test("the turn start and end attributes hold exactly the listed names", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.emit({
    type: "turn_end",
    message: assistantMessage({ durationMs: MESSAGE_DURATION_MS }),
    toolResults: [],
  });
  assert.deepEqual(
    names(startOf(records, SpanOperation.Turn)?.attributes),
    [...TURN_ATTRIBUTES, ...IDENTITY_NAMES].sort(),
  );
  assert.deepEqual(
    names(endOf(records, SpanOperation.Turn)?.attributes),
    TURN_END_ATTRIBUTES,
  );
});

test("a turn error ends with the provider failure code and no text", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "turn_end",
    message: assistantMessage({
      stopReason: "error",
      errorMessage: "429 rate limit",
    }),
    toolResults: [],
  });
  const end = endOf(records, SpanOperation.Turn);
  assert.equal(end?.status, SpanStatus.Error);
  assert.equal(end?.attributes?.["error.type"], RATE_LIMITED);
  assert.deepEqual(end?.attributes?.["gen_ai.response.finish_reasons"], [
    "error",
  ]);
  assert.deepEqual(textRecordsOf(records), []);
});

test("the turn omits the entry id, the cost and the duration when it has none", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "turn_end",
    message: assistantMessage({
      usage: { ...assistantMessage().usage, cost: { total: Number.NaN } },
    }),
    toolResults: [],
  });
  const attributes = endOf(records, SpanOperation.Turn)?.attributes ?? {};
  assert.deepEqual(
    [
      "kanthord.session.entry_id",
      "kanthord.usage.cost_usd",
      "kanthord.turn.model_duration_ms",
    ].filter((name) => name in attributes),
    [],
  );
});

test("the turn names the last assistant entry that follows the turn start", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.emit({ type: "turn_start" });
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.append({ type: "message", message: { role: "toolResult" } });
  scripted.append({ type: "message", message: assistantMessage() });
  scripted.append();
  scripted.emit({ type: "message_end", message: assistantMessage() });
  scripted.emit({
    type: "turn_end",
    message: assistantMessage(),
    toolResults: [],
  });
  const attributes = endOf(records, SpanOperation.Turn)?.attributes ?? {};
  assert.equal(attributes["kanthord.session.entry_id"], LAST_ASSISTANT_ENTRY);
  assert.ok(Number(attributes["kanthord.turn.model_duration_ms"]) >= NO_SENT);
});

test("a tool error ends with Error and the tool_error type", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  scripted.emit({
    type: "tool_execution_end",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    result: { content: [{ type: "text", text: "boom" }] },
    isError: true,
  });
  const end = endOf(records, SpanOperation.Tool);
  assert.equal(end?.status, SpanStatus.Error);
  assert.equal(end?.attributes?.["error.type"], AgentErrorType.ToolError);
  assert.equal(end?.attributes?.["kanthord.tool.outcome"], OUTCOME_ERROR);
  assert.deepEqual(names(end?.attributes), [
    "error.type",
    ...TOOL_END_ATTRIBUTES,
  ]);
  assert.deepEqual(textRecordsOf(records), []);
});

const BASH_PID = 4242;
const REQUESTED_TIMEOUT_MS = 3600000;
const APPLIED_TIMEOUT_MS = 599000;

function timeoutEnd(timeout: ToolTimeout | undefined) {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const pending = new Map(timeout === undefined ? [] : [[TOOL_CALL, timeout]]);
  traceAgent(scripted.session, spans, TRACED_AGENT, {
    ...TRACING,
    processes: {
      take: () => undefined,
      takeTimeout: (toolCallId: string) => {
        const recorded = pending.get(toolCallId);
        pending.delete(toolCallId);
        return recorded;
      },
    },
  });
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  scripted.emit({
    type: "tool_execution_end",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
  });
  assert.equal(pending.has(TOOL_CALL), false);
  return endOf(records, SpanOperation.Tool)?.attributes ?? {};
}

test("a bash call with a requested and a cut timeout records both values", () => {
  const attributes = timeoutEnd({
    requestedMs: REQUESTED_TIMEOUT_MS,
    appliedMs: APPLIED_TIMEOUT_MS,
  });
  assert.equal(
    attributes["kanthord.tool.timeout.requested_ms"],
    REQUESTED_TIMEOUT_MS,
  );
  assert.equal(
    attributes["kanthord.tool.timeout.applied_ms"],
    APPLIED_TIMEOUT_MS,
  );
});

test("a bash call without a requested timeout records only the applied value", () => {
  const attributes = timeoutEnd({
    requestedMs: null,
    appliedMs: APPLIED_TIMEOUT_MS,
  });
  assert.deepEqual(names(attributes), [
    "kanthord.tool.duration_ms",
    "kanthord.tool.outcome",
    "kanthord.tool.timeout.applied_ms",
  ]);
  assert.equal(
    attributes["kanthord.tool.timeout.applied_ms"],
    APPLIED_TIMEOUT_MS,
  );
});

test("a tool end without a recorded timeout holds no timeout attribute", () => {
  assert.deepEqual(names(timeoutEnd(undefined)), TOOL_END_ATTRIBUTES);
});

function bashProcessEnd(killed: boolean) {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const ended = new Map([[TOOL_CALL, { pid: BASH_PID, killed }]]);
  traceAgent(scripted.session, spans, TRACED_AGENT, {
    ...TRACING,
    processes: {
      take: (toolCallId: string) => {
        const bashProcess = ended.get(toolCallId);
        ended.delete(toolCallId);
        return bashProcess;
      },
      takeTimeout: () => undefined,
    },
  });
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  scripted.emit({
    type: "tool_execution_end",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    result: { content: [{ type: "text", text: "Command timed out" }] },
    isError: killed,
  });
  assert.equal(ended.has(TOOL_CALL), false);
  return endOf(records, SpanOperation.Tool)?.attributes ?? {};
}

test("a bash call that the timeout or the abort ended records its process and the kill", () => {
  const attributes = bashProcessEnd(true);
  assert.equal(attributes["process.pid"], BASH_PID);
  assert.equal(attributes["process.group_leader.pid"], BASH_PID);
  assert.equal(attributes["kanthord.tool.killed"], true);
  assert.equal(attributes["kanthord.tool.outcome"], OUTCOME_ERROR);
});

test("a bash call that exits records its process and no kill", () => {
  const attributes = bashProcessEnd(false);
  assert.equal(attributes["process.pid"], BASH_PID);
  assert.equal(attributes["process.group_leader.pid"], BASH_PID);
  assert.equal(attributes["kanthord.tool.killed"], false);
});

test("a turn under a worker.task span names that span as its parent", async () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  const task = await spans.within(
    { key: "task:1", operation: SpanOperation.Task },
    async (taskId) => {
      scripted.emit({ type: "turn_start" });
      return taskId;
    },
  );
  assert.equal(startOf(records, SpanOperation.Turn)?.parent_span_id, task);
});

test("the agent tracer writes the chain position and level of the pinned selection on a turn", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const { session } = scripted;
  const listener = scripted.emit;
  traceAgent(
    session,
    spans,
    {
      ...TRACED_AGENT,
      position: SECOND_POSITION,
      level: ChainLevel.Binding,
    },
    TRACING,
  );
  listener({ type: "turn_start" });
  const turn = spanRecords(records).find(
    (record) => record.operation === SpanOperation.Turn,
  );
  assert.equal(
    turn?.attributes?.["kanthord.agent.name"],
    TRACED_AGENT.agent_name,
  );
  assert.equal(
    turn?.attributes?.["kanthord.agent.chain_position"],
    SECOND_POSITION,
  );
  assert.equal(
    turn?.attributes?.["kanthord.agent.chain_level"],
    ChainLevel.Binding,
  );
});

test("a text split never cuts a surrogate pair", () => {
  const { records, spans } = recorder();
  spans.start({
    key: "verification:2",
    operation: SpanOperation.Verification,
    texts: { output: `${"x".repeat(SPLIT_BEFORE_PAIR)}😀${"y".repeat(10)}` },
  });
  const parts = records.flatMap((record) =>
    record.kind === RecordKind.Text ? [record.text] : [],
  );
  assert.equal(parts.length, TWO_PARTS);
  assert.ok(parts.every((part) => part.isWellFormed()));
});

test("a tracer fault is counted and never thrown", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const { session } = scripted;
  const listener = scripted.emit;
  traceAgent(session, spans, TRACED_AGENT, TRACING);
  listener({ type: "turn_start" });
  listener({ type: "tool_execution_start", toolCallId: "", toolName: "bash" });
  assert.doesNotThrow(() =>
    listener({
      type: "turn_end",
      message: { role: "assistant", content: [] },
      toolResults: [],
    }),
  );
  assert.equal(spans.faultCount(), ONE_FAULT);
  assert.equal(
    spanRecords(records).filter(
      (record) => record.operation === SpanOperation.Tool,
    ).length,
    NO_TOOL_SPANS,
  );
});

test("the tracer sends each entry once, in order, from sequence 1", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append();
  scripted.emit({ type: "turn_start" });
  scripted.append();
  scripted.append();
  scripted.emit({ type: "message_end" });
  scripted.emit({ type: "message_end" });
  const sent = entryRecords(records);
  assert.deepEqual(
    sent.map((record) => record.sequence),
    [1, 2, 3],
  );
  assert.deepEqual(
    sent.map((record) => record.entry_id),
    ["00000001", "00000002", "00000003"],
  );
  assert.equal(sent[0]?.session_id, SESSION_ID);
  assert.equal(sent[0]?.trace_id, CLAIM.trace_id);
  assert.equal(spans.faultCount(), NO_SENT);
});

test("the returned function sends the entry that pi appended after the last event", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const stop = traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append();
  scripted.emit({ type: "message_end" });
  scripted.append();
  assert.equal(entryRecords(records).length, ONE_ENTRY);
  assert.equal(stop(), TWO_ENTRIES);
  assert.deepEqual(
    entryRecords(records).map((record) => record.sequence),
    [1, 2],
  );
});

test("the returned function ends the open tool and turn with Error and stopped, once", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const stop = traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: {},
  });
  assert.equal(stop(), NO_SENT);
  const ends = spanRecords(records).filter((record) => record.end_time);
  assert.deepEqual(
    ends.map((record) => record.operation),
    [SpanOperation.Tool, SpanOperation.Turn],
  );
  for (const end of ends) {
    assert.equal(end.status, SpanStatus.Error);
    assert.equal(end.attributes?.["error.type"], AgentErrorType.Stopped);
  }
  const written = records.length;
  scripted.append();
  assert.equal(stop(), NO_SENT);
  assert.equal(records.length, written);
  assert.equal(scripted.unsubscribed(), ONE_UNSUBSCRIBE);
});

test("a stop during a tool call ends the turn with stopped and the usage of its finished reply", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const stop = traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.emit({ type: "turn_start" });
  scripted.emit({
    type: "message_end",
    message: assistantMessage({ stopReason: "toolUse" }),
  });
  scripted.emit({
    type: "tool_execution_start",
    toolCallId: TOOL_CALL,
    toolName: "bash",
    args: {},
  });
  stop();
  const tool = endOf(records, SpanOperation.Tool);
  assert.equal(tool?.status, SpanStatus.Error);
  assert.deepEqual(tool?.attributes, { "error.type": AgentErrorType.Stopped });
  const turn = endOf(records, SpanOperation.Turn);
  assert.equal(turn?.status, SpanStatus.Error);
  assert.equal(turn?.attributes?.["error.type"], AgentErrorType.Stopped);
  assert.equal(
    turn?.attributes?.["gen_ai.usage.input_tokens"],
    INPUT_TOKENS + CACHE_READ + CACHE_WRITE,
  );
  assert.equal(turn?.attributes?.["gen_ai.usage.output_tokens"], OUTPUT_TOKENS);
  assert.equal(
    turn?.attributes?.["gen_ai.usage.cache_read.input_tokens"],
    CACHE_READ,
  );
  assert.equal(
    turn?.attributes?.["gen_ai.usage.cache_creation.input_tokens"],
    CACHE_WRITE,
  );
  assert.equal(turn?.attributes?.["kanthord.usage.cost_usd"], COST_USD);
});

test("a credential secret in a tool result reaches the sink as [redacted]", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, {
    ...TRACING,
    secrets: [CREDENTIAL_SECRET],
  });
  scripted.append({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: `token ${CREDENTIAL_SECRET}` }],
    },
  });
  scripted.emit({ type: "message_end" });
  const [record] = entryRecords(records);
  assert.equal(record?.tool_call_id, TOOL_CALL);
  assert.ok(!JSON.stringify(records).includes(CREDENTIAL_SECRET));
  assert.ok(JSON.stringify(record?.entry).includes("token [redacted]"));
});

test("a turn start refreshes the secrets and a rejection keeps the old list", async () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  const refreshes: (() => Promise<readonly string[]>)[] = [
    async () => [REFRESHED_SECRET],
    async () => {
      throw new Error("refresh failed");
    },
  ];
  let calls = 0;
  traceAgent(scripted.session, spans, TRACED_AGENT, {
    ...TRACING,
    refreshSecrets: () => refreshes[calls++]!(),
  });
  scripted.emit({ type: "turn_start" });
  await new Promise((resolve) => setImmediate(resolve));
  scripted.emit({ type: "turn_start" });
  await new Promise((resolve) => setImmediate(resolve));
  scripted.append({ data: `a ${REFRESHED_SECRET}` });
  scripted.emit({ type: "message_end" });
  assert.equal(calls, TWO_REFRESHES);
  assert.ok(!JSON.stringify(records).includes(REFRESHED_SECRET));
});

test("an entry with an invalid identity is skipped and counted as a fault", () => {
  const { records, spans } = recorder();
  const scripted = scriptedSession();
  traceAgent(scripted.session, spans, TRACED_AGENT, TRACING);
  scripted.append({ id: "BAD ID" });
  scripted.append({ parentId: null });
  scripted.emit({ type: "message_end" });
  assert.deepEqual(
    entryRecords(records).map((record) => record.sequence),
    [2],
  );
  assert.equal(spans.faultCount(), ONE_FAULT);
});
