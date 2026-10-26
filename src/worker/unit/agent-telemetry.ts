import assert from "node:assert/strict";
import type {
  AgentSession,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SpanStatus, type Attributes } from "../../tracking/contract.ts";
import type { AgentSetup } from "../contract.ts";
import { isObject } from "../../kernel/values.ts";
import { providerFailureOf } from "../../llm/provider-failure.ts";
import { SpanOperation, type SpanRecorder } from "./telemetry.ts";
import { sessionEntryRecord } from "./session-entries.ts";
import type { TurnPrompt } from "./native-agent.ts";
import type { ToolProcesses, ToolTimeout } from "./tool-table.ts";
import type { BashProcess } from "../../agent/bash-process.ts";

const TURN_START = "turn_start";
const TURN_END = "turn_end";
const MESSAGE_END = "message_end";
const MESSAGE_ENTRY = "message";
const CHAT_OPERATION = "chat";
const TOOL_OPERATION = "execute_tool";
const TOOL_START = "tool_execution_start";
const TOOL_END = "tool_execution_end";
const ASSISTANT_ROLE = "assistant";
const ERROR_STOP = "error";
const TOOLS_OPEN_MAX = 1024;
const ToolOutcome = { Ok: "ok", Error: "error" } as const;
export const AgentErrorType = {
  ToolError: "tool_error",
  Stopped: "stopped",
} as const;
const PROMPT_TEMPLATE_ATTRIBUTE = "kanthord.prompt.template";
const PROMPT_TEMPLATE_DIGEST_ATTRIBUTE = "kanthord.prompt.template.digest";
const PROMPT_WORK_DIGEST_ATTRIBUTE = "kanthord.prompt.work.digest";
const WORKER_BINDING_ATTRIBUTE = "kanthord.worker_binding.id";
const AGENT_ENABLEMENT_ATTRIBUTE = "kanthord.agent_enablement.id";
const SESSION_ENTRY_ATTRIBUTE = "kanthord.session.entry_id";
const TOOL_TIMEOUT_APPLIED_ATTRIBUTE = "kanthord.tool.timeout.applied_ms";
const TOOL_TIMEOUT_REQUESTED_ATTRIBUTE = "kanthord.tool.timeout.requested_ms";
const FIRST_SEQUENCE = 1;
const NO_ENTRIES = 0;

function isAssistant(message: AgentMessage): message is AssistantMessage {
  return (
    isObject(message) && "role" in message && message.role === ASSISTANT_ROLE
  );
}

function turnAttributes(
  message: AssistantMessage,
  entryId: string | null,
  modelDurationMs: number | null,
): Attributes {
  assert.ok(message.usage);
  assert.equal(message.role, ASSISTANT_ROLE);
  const { usage } = message;
  const failure =
    message.stopReason === ERROR_STOP
      ? providerFailureOf(message.errorMessage ?? "")
      : null;
  const duration = Number.isFinite(message.durationMs)
    ? message.durationMs
    : modelDurationMs;
  return {
    "gen_ai.response.model": message.responseModel ?? message.model,
    "gen_ai.provider.name": message.provider,
    "gen_ai.usage.input_tokens":
      usage.input + usage.cacheRead + usage.cacheWrite,
    "gen_ai.usage.output_tokens": usage.output,
    "gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
    "gen_ai.usage.cache_creation.input_tokens": usage.cacheWrite,
    ...(Number.isFinite(usage.cost?.total)
      ? { "kanthord.usage.cost_usd": usage.cost.total }
      : {}),
    "gen_ai.response.finish_reasons": [message.stopReason],
    ...(failure === null ? {} : { "error.type": failure }),
    ...(entryId === null ? {} : { [SESSION_ENTRY_ATTRIBUTE]: entryId }),
    ...(duration === null || duration === undefined
      ? {}
      : { "kanthord.turn.model_duration_ms": duration }),
  };
}

function processAttributes(bashProcess: BashProcess | undefined): Attributes {
  if (bashProcess === undefined) return {};
  return {
    "process.pid": bashProcess.pid,
    "process.group_leader.pid": bashProcess.pid,
    "kanthord.tool.killed": bashProcess.killed,
  };
}

function timeoutAttributes(timeout: ToolTimeout | undefined): Attributes {
  if (timeout === undefined) return {};
  return {
    [TOOL_TIMEOUT_APPLIED_ATTRIBUTE]: timeout.appliedMs,
    ...(timeout.requestedMs === null
      ? {}
      : { [TOOL_TIMEOUT_REQUESTED_ATTRIBUTE]: timeout.requestedMs }),
  };
}

function promptAttributes(prompt: TurnPrompt | null): Attributes {
  if (prompt === null) return {};
  return {
    [PROMPT_TEMPLATE_ATTRIBUTE]: prompt.template,
    [PROMPT_TEMPLATE_DIGEST_ATTRIBUTE]: prompt.template_digest,
    [PROMPT_WORK_DIGEST_ATTRIBUTE]: prompt.work_digest,
  };
}

type SessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];
type EventOf<T extends SessionEvent["type"]> = Extract<
  SessionEvent,
  { type: T }
>;

type TracedAgent = Pick<
  AgentSetup,
  | "agent_name"
  | "position"
  | "level"
  | "effective_configuration"
  | "enablement_id"
  | "worker_binding_id"
>;

export interface AgentTracing {
  sessionId: string;
  secrets: readonly string[];
  refreshSecrets: () => Promise<readonly string[]>;
  processes: Pick<ToolProcesses, "take" | "takeTimeout">;
  promptOf: () => TurnPrompt | null;
}

class AgentTracer {
  private readonly spans: SpanRecorder;
  private readonly agentName: string;
  private readonly position: number;
  private readonly level: AgentSetup["level"];
  private readonly model: string;
  private readonly enablementId: string | null;
  private readonly workerBindingId: string;
  private turn: string | null = null;
  private turnStartedAt = NO_ENTRIES;
  private turnEntryCount = NO_ENTRIES;
  private modelDurationMs: number | null = null;
  private readonly tools = new Map<string, { span: string; started: number }>();
  private readonly session: AgentSession;
  private readonly sessionId: string;
  private readonly refreshSecrets: AgentTracing["refreshSecrets"];
  private readonly processes: AgentTracing["processes"];
  private readonly promptOf: AgentTracing["promptOf"];
  private secrets: readonly string[];
  private sent = NO_ENTRIES;

  constructor(
    session: AgentSession,
    spans: SpanRecorder,
    agent: TracedAgent,
    tracing: AgentTracing,
  ) {
    assert.ok(spans);
    assert.ok(agent.agent_name);
    assert.ok(tracing.sessionId);
    this.session = session;
    this.sessionId = tracing.sessionId;
    this.secrets = tracing.secrets;
    this.refreshSecrets = tracing.refreshSecrets;
    this.processes = tracing.processes;
    this.promptOf = tracing.promptOf;
    this.spans = spans;
    this.agentName = agent.agent_name;
    this.position = agent.position;
    this.level = agent.level;
    this.model = agent.effective_configuration.model_identifier;
    this.enablementId = agent.enablement_id;
    this.workerBindingId = agent.worker_binding_id;
  }

  observe(event: SessionEvent): void {
    assert.ok(event.type);
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    if (event.type === TURN_START) this.turnStarted();
    else if (event.type === TOOL_START) this.toolStarted(event);
    else if (event.type === TOOL_END) this.toolEnded(event);
    else if (event.type === TURN_END) this.turnEnded(event);
    else if (event.type === MESSAGE_END) this.messageEnded(event);
  }

  sentCount(): number {
    return this.sent;
  }

  sendEntries(): void {
    const count = this.session.sessionManager.getEntryCount();
    if (count <= this.sent) return;
    const entries = this.session.sessionManager.getEntries();
    const first = this.sent;
    this.sent = count;
    const records = entries.slice(first, count).flatMap((entry, offset) => {
      const record = this.entryRecord(entry, first + offset + FIRST_SEQUENCE);
      if (record === null) this.spans.fault();
      return record === null ? [] : [record];
    });
    this.spans.sessionEntries(records);
  }

  stop(): void {
    for (const tool of this.tools.values()) this.endStopped(tool.span);
    this.tools.clear();
    if (this.turn === null) return;
    const open = this.turn;
    this.turn = null;
    this.endStopped(open);
  }

  private endStopped(spanId: string): void {
    this.spans.end(spanId, {
      status: SpanStatus.Error,
      attributes: { "error.type": AgentErrorType.Stopped },
    });
  }

  private entryRecord(entry: SessionEntry, sequence: number) {
    try {
      return sessionEntryRecord({
        traceId: this.spans.traceId(),
        sessionId: this.sessionId,
        sequence,
        entry,
        secrets: this.secrets,
      });
    } catch {
      return null;
    }
  }

  private turnStarted(): void {
    assert.ok(this.agentName);
    this.refreshSecrets().then(
      (secrets) => {
        this.secrets = secrets;
      },
      () => {},
    );
    if (this.turn !== null)
      this.spans.end(this.turn, { status: SpanStatus.Error });
    const index = this.spans.nextTurn();
    this.turn = this.spans.start({
      key: `turn:${index}`,
      operation: SpanOperation.Turn,
      attributes: {
        "kanthord.agent.name": this.agentName,
        "kanthord.agent.chain_position": this.position,
        "kanthord.agent.chain_level": this.level,
        "kanthord.turn.index": index,
        "gen_ai.operation.name": CHAT_OPERATION,
        "gen_ai.conversation.id": this.sessionId,
        "gen_ai.request.model": this.model,
        [WORKER_BINDING_ATTRIBUTE]: this.workerBindingId,
        ...(this.enablementId === null
          ? {}
          : { [AGENT_ENABLEMENT_ATTRIBUTE]: this.enablementId }),
        ...promptAttributes(this.promptOf()),
      },
    });
    this.turnStartedAt = Date.now();
    this.turnEntryCount = this.session.sessionManager.getEntryCount();
    this.modelDurationMs = null;
    assert.ok(this.turn);
  }

  private messageEnded(event: EventOf<typeof MESSAGE_END>): void {
    if (this.turn === null || !isAssistant(event.message)) return;
    this.modelDurationMs = Date.now() - this.turnStartedAt;
  }

  private assistantEntryId(): string | null {
    const entries = this.session.sessionManager
      .getEntries()
      .slice(this.turnEntryCount);
    const entry = entries.findLast(
      (candidate) =>
        candidate.type === MESSAGE_ENTRY &&
        candidate.message.role === ASSISTANT_ROLE,
    );
    return entry?.id ?? null;
  }

  private toolStarted(event: EventOf<typeof TOOL_START>): void {
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    if (this.turn === null || !event.toolCallId) return;
    assert.ok(this.turn);
    const entryId = this.assistantEntryId();
    this.tools.set(event.toolCallId, {
      started: Date.now(),
      span: this.spans.start({
        key: `tool:${this.turn}:${event.toolCallId}`,
        operation: SpanOperation.Tool,
        parent: this.turn,
        attributes: {
          "gen_ai.operation.name": TOOL_OPERATION,
          "gen_ai.conversation.id": this.sessionId,
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.call.id": event.toolCallId,
          ...(entryId === null ? {} : { [SESSION_ENTRY_ATTRIBUTE]: entryId }),
        },
      }),
    });
  }

  private toolEnded(event: EventOf<typeof TOOL_END>): void {
    assert.ok(this.tools.size <= TOOLS_OPEN_MAX);
    const bashProcess = this.processes.take(event.toolCallId);
    const timeout = this.processes.takeTimeout(event.toolCallId);
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
        ...(event.isError ? { "error.type": AgentErrorType.ToolError } : {}),
        ...processAttributes(bashProcess),
        ...timeoutAttributes(timeout),
      },
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
    this.spans.end(ended, {
      status: failed ? SpanStatus.Error : SpanStatus.Ok,
      attributes: turnAttributes(
        event.message,
        this.assistantEntryId(),
        this.modelDurationMs,
      ),
    });
  }
}

export function traceAgent(
  session: AgentSession,
  spans: SpanRecorder,
  agent: TracedAgent,
  tracing: AgentTracing,
): () => number {
  assert.ok(session);
  assert.ok(agent.agent_name);
  const tracer = new AgentTracer(session, spans, agent, tracing);
  const guarded = (work: () => void) => {
    try {
      work();
    } catch {
      spans.fault();
    }
  };
  const unsubscribe = session.subscribe((event) => {
    guarded(() => tracer.observe(event));
    guarded(() => tracer.sendEntries());
  });
  let stopped = false;
  return () => {
    if (stopped) return tracer.sentCount();
    stopped = true;
    guarded(() => tracer.sendEntries());
    guarded(() => tracer.stop());
    unsubscribe();
    return tracer.sentCount();
  };
}
