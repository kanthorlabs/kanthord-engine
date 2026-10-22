import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  RecordKind,
  SpanStatus,
  type TelemetryRecord,
} from "../../tracking/contract.ts";
import {
  SpanOperation,
  SpanRecorder,
  mintRunKey,
  telemetrySpanId,
  type TelemetrySink,
} from "./telemetry.ts";
import { traceAgent } from "./agent-telemetry.ts";
import { GitStep, withinGit } from "./method-telemetry.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ChainLevel } from "../../agent/contract.ts";

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
const NO_TOOL_SPANS = 0;
const SECOND_POSITION = 1;
const TRACED_AGENT = {
  agent_name: "swe@1",
  position: 0,
  level: ChainLevel.Enablement,
} as const;

function recorder() {
  const records: TelemetryRecord[] = [];
  const sink: TelemetrySink = {
    write: (batch) => records.push(...batch),
    flush: async () => {},
  };
  return { records, spans: new SpanRecorder(CLAIM, WORKER, sink) };
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

test("the agent tracer writes a turn and its tool call", () => {
  const { records, spans } = recorder();
  let listener: (event: unknown) => void = () => {};
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    },
  } as unknown as AgentSession;
  traceAgent(session, spans, TRACED_AGENT);
  listener({ type: "turn_start" });
  listener({
    type: "tool_execution_start",
    toolCallId: "call_1",
    toolName: "bash",
    args: { command: "npm test" },
  });
  listener({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "1 passed" }] },
    isError: false,
  });
  listener({
    type: "turn_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      model: "glm",
      stopReason: "error",
      errorMessage: "429 rate limit",
      usage: { input: INPUT_TOKENS, output: 2, cacheRead: 0, cacheWrite: 0 },
    },
    toolResults: [],
  });
  const written = spanRecords(records);
  const turnEnd = written.find(
    (record) => record.operation === SpanOperation.Turn && record.end_time,
  );
  const tool = written.find(
    (record) => record.operation === SpanOperation.Tool,
  );
  assert.equal(tool?.parent_span_id, turnEnd?.span_id);
  assert.equal(turnEnd?.status, SpanStatus.Error);
  assert.equal(
    turnEnd?.attributes?.["gen_ai.usage.input_tokens"],
    INPUT_TOKENS,
  );
  assert.ok(turnEnd?.text_ids?.some((id) => id.endsWith(":error")));
});

test("the agent tracer writes the chain position and level of the pinned selection on a turn", () => {
  const { records, spans } = recorder();
  let listener: (event: unknown) => void = () => {};
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    },
  } as unknown as AgentSession;
  traceAgent(session, spans, {
    agent_name: "swe@1",
    position: SECOND_POSITION,
    level: ChainLevel.Binding,
  });
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
  let listener: (event: unknown) => void = () => {};
  const session = {
    subscribe: (next: (event: unknown) => void) => {
      listener = next;
      return () => {};
    },
  } as unknown as AgentSession;
  traceAgent(session, spans, TRACED_AGENT);
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
