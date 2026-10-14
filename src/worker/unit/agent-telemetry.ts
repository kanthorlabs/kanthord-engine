import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SpanStatus, type Attributes } from "../../tracking/contract.ts";
import { isObject, isString } from "../../kernel/values.ts";
import { providerFailureOf } from "../../llm/provider-failure.ts";
import { SpanOperation, type SpanRecorder } from "./telemetry.ts";

const TURN_START = "turn_start";
const TURN_END = "turn_end";
const TOOL_START = "tool_execution_start";
const TOOL_END = "tool_execution_end";
const ASSISTANT_ROLE = "assistant";
const ERROR_STOP = "error";
const TEXT_PART = "text";
const TOOLS_OPEN_MAX = 1024;
const ToolOutcome = { Ok: "ok", Error: "error" } as const;

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return (
    isObject(message) && "role" in message && message.role === ASSISTANT_ROLE
  );
}

function replyText(message: AssistantMessage): string {
  assert.ok(Array.isArray(message.content));
  assert.equal(message.role, ASSISTANT_ROLE);
  return message.content
    .flatMap((part) => (part.type === TEXT_PART ? [part.text] : []))
    .join("\n");
}

function turnAttributes(message: AssistantMessage): Attributes {
  assert.ok(message.usage);
  assert.equal(message.role, ASSISTANT_ROLE);
  const failure =
    message.stopReason === ERROR_STOP
      ? providerFailureOf(message.errorMessage ?? "")
      : null;
  return {
    "gen_ai.request.model": message.model,
    "gen_ai.usage.input_tokens": message.usage.input,
    "gen_ai.usage.output_tokens": message.usage.output,
    "gen_ai.usage.cache_read_tokens": message.usage.cacheRead,
    "gen_ai.usage.cache_write_tokens": message.usage.cacheWrite,
    "gen_ai.response.finish_reasons": [message.stopReason],
    ...(failure === null ? {} : { "error.type": failure }),
  };
}

function textOf(value: unknown): string {
  if (isString(value)) return value;
  if (value === undefined) return "";
  return JSON.stringify(value) ?? "";
}

function resultText(result: unknown): string {
  if (!isObject(result) || !("content" in result)) return textOf(result);
  const content = (result as { content: unknown }).content;
  if (!Array.isArray(content)) return textOf(result);
  return content
    .flatMap((part: unknown) =>
      isObject(part) && "text" in part && isString(part.text)
        ? [part.text]
        : [],
    )
    .join("\n");
}

type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
type EventOf<T extends SessionEvent["type"]> = Extract<
  SessionEvent,
  { type: T }
>;

class AgentTracer {
  private readonly spans: SpanRecorder;
  private readonly agentName: string;
  private turn: string | null = null;
  private readonly tools = new Map<string, { span: string; started: number }>();

  constructor(spans: SpanRecorder, agentName: string) {
    assert.ok(spans);
    assert.ok(agentName);
    this.spans = spans;
    this.agentName = agentName;
  }

  observe(event: SessionEvent): void {
    assert.ok(event.type);
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    if (event.type === TURN_START) this.turnStarted();
    else if (event.type === TOOL_START) this.toolStarted(event);
    else if (event.type === TOOL_END) this.toolEnded(event);
    else if (event.type === TURN_END) this.turnEnded(event);
  }

  private turnStarted(): void {
    assert.ok(this.agentName);
    if (this.turn !== null)
      this.spans.end(this.turn, { status: SpanStatus.Error });
    const index = this.spans.nextTurn();
    this.turn = this.spans.start({
      key: `turn:${index}`,
      operation: SpanOperation.Turn,
      attributes: {
        "kanthord.agent.name": this.agentName,
        "kanthord.turn.index": index,
      },
    });
    assert.ok(this.turn);
  }

  private toolStarted(event: EventOf<typeof TOOL_START>): void {
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    if (this.turn === null || !event.toolCallId) return;
    assert.ok(this.turn);
    this.tools.set(event.toolCallId, {
      started: Date.now(),
      span: this.spans.start({
        key: `tool:${this.turn}:${event.toolCallId}`,
        operation: SpanOperation.Tool,
        parent: this.turn,
        attributes: {
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.call.id": event.toolCallId,
        },
        texts: { input: textOf(event.args) },
      }),
    });
  }

  private toolEnded(event: EventOf<typeof TOOL_END>): void {
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    const tool = this.tools.get(event.toolCallId);
    if (!tool) return;
    assert.ok(tool.span);
    this.tools.delete(event.toolCallId);
    this.spans.end(tool.span, {
      status: event.isError ? SpanStatus.Error : SpanStatus.Ok,
      attributes: {
        "kanthord.tool.outcome": event.isError
          ? ToolOutcome.Error
          : ToolOutcome.Ok,
        "kanthord.tool.duration_ms": Date.now() - tool.started,
      },
      texts: { output: resultText(event.result) },
    });
  }

  private turnEnded(event: EventOf<typeof TURN_END>): void {
    assert.ok(event.message);
    const ended = this.turn;
    if (ended === null) return;
    this.turn = null;
    assert.ok(ended);
    if (!isAssistant(event.message)) {
      this.spans.end(ended, { status: SpanStatus.Ok });
      return;
    }
    const failed = event.message.stopReason === ERROR_STOP;
    const reply = replyText(event.message);
    this.spans.end(ended, {
      status: failed ? SpanStatus.Error : SpanStatus.Ok,
      attributes: turnAttributes(event.message),
      texts: failed
        ? { reply, error: event.message.errorMessage ?? "" }
        : { reply },
    });
  }
}

export function traceAgent(
  session: AgentSession,
  spans: SpanRecorder,
  agentName: string,
): () => void {
  assert.ok(session);
  assert.ok(agentName);
  const tracer = new AgentTracer(spans, agentName);
  return session.subscribe((event) => {
    try {
      tracer.observe(event);
    } catch {
      spans.fault();
    }
  });
}
