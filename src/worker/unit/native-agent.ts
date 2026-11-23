import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KnownSecrets } from "../../agent/known-secrets.ts";
import type { Context } from "../../kernel/context.ts";
import type { ExecutionBudget } from "./budget.ts";
import { digest, type WorkPrompt } from "../../agent/prompt-composer.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import type {
  PortSession,
  SessionOpenRequest,
  SessionPort,
  SessionTrace,
  SessionTraceFactory,
  SessionTraceStart,
} from "../../agent/agent-port.ts";
import {
  redactionSummary,
  type SensitiveTextRedaction,
} from "../../agent/hooks/sensitive-text-redaction.ts";
import { countTurns } from "../../agent/pinned-layers.ts";
import type { ExecutionSetup } from "../contract.ts";
import { EndReason, ExecutionStop } from "./execution-stop.ts";
import { providerFailureOf } from "../../llm/provider-failure.ts";
import { redactReason, thrownReason } from "../../kernel/probe.ts";
import { CodedError } from "../../kernel/errors.ts";
import { type Attributes, SpanStatus } from "../../tracking/contract.ts";
import { traceAgent } from "./agent-telemetry.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import {
  SessionFormat,
  SpanOperation,
  type SpanRecorder,
} from "./telemetry.ts";
import { PINNED_CONTEXT_TYPE, PinnedContextPart } from "./session-entries.ts";

const REASONING_EFFORT_ATTRIBUTE = "kanthord.agent.reasoning_effort";

export interface NativeOpenRequest extends SessionOpenRequest {
  setup: Pick<ExecutionSetup, "agents" | "execution_id" | "templates">;
}

export interface NativeAgentInput {
  sessions: SessionPort<NativeTrace>;
  request: NativeOpenRequest;
  budget: ExecutionBudget;
  knownSecrets: KnownSecrets;
  context: Context;
}
export interface TurnPrompt {
  template: PromptTemplate;
  template_digest: string;
  work_digest: string;
}

const ASSISTANT_ROLE = "assistant";
const PROVIDER_ERROR = "error";
const COMPLETE_REPLY = "stop";
const TOOL_CALL_PART = "toolCall";
const TEXT_PART = "text";
const NO_TEXT = "";

export async function promptStop(
  error: unknown,
  secrets: KnownSecrets,
): Promise<unknown> {
  if (error instanceof ExecutionStop) return error;
  return new ExecutionStop(
    EndReason.OperationFailed,
    error instanceof CodedError ? error.code : null,
    { detail: thrownReason(error, await secrets()) },
  );
}

async function providerFailure(
  messages: readonly AgentMessage[],
  secrets: KnownSecrets,
): Promise<ExecutionStop | null> {
  const last = messages.findLast(
    (message): message is AssistantMessage => message.role === ASSISTANT_ROLE,
  );
  if (last?.stopReason !== PROVIDER_ERROR) return null;
  const errorMessage = last.errorMessage ?? "";
  const detail = redactReason(errorMessage, await secrets());
  return new ExecutionStop(
    EndReason.ProviderFailed,
    providerFailureOf(errorMessage),
    { detail: detail || null },
  );
}

function isCompleteReply(messages: readonly AgentMessage[]): boolean {
  const last = messages.findLast(
    (message): message is AssistantMessage => message.role === ASSISTANT_ROLE,
  );
  if (last === undefined || last.stopReason !== COMPLETE_REPLY) return false;
  if (last.content.some((part) => part.type === TOOL_CALL_PART)) return false;
  return last.content.some(
    (part) => part.type === TEXT_PART && part.text.trim() !== NO_TEXT,
  );
}

interface TraceWatch {
  secrets: readonly string[];
  refreshSecrets: KnownSecrets;
  promptOf: () => TurnPrompt | null;
}

export interface NativeTrace extends SessionTrace {
  watch(opened: PortSession<NativeTrace>, tracing: TraceWatch): void;
}

function redactionAttributes(redaction: SensitiveTextRedaction): Attributes {
  return Object.fromEntries(
    Object.entries(redactionSummary(redaction.counts())).map(
      ([name, value]) => [`kanthord.session.${name}`, value],
    ),
  );
}

function sessionAttributes(
  start: SessionTraceStart,
  sessionId: string,
): Attributes {
  const { agent } = start;
  return {
    "gen_ai.operation.name": "invoke_agent",
    "gen_ai.conversation.id": sessionId,
    "gen_ai.agent.name": agent.agent_name,
    "kanthord.agent.name": agent.agent_name,
    "kanthord.agent.chain_position": agent.position,
    "kanthord.agent.chain_level": agent.level,
    "gen_ai.request.model": agent.effective_configuration.model_identifier,
    [REASONING_EFFORT_ATTRIBUTE]:
      agent.effective_configuration.reasoning_effort,
    "kanthord.session.format": SessionFormat.Pi,
    "kanthord.session.format_version": start.formatVersion,
  };
}

export function nativeSessionTrace(
  spans: SpanRecorder | undefined,
): SessionTraceFactory<NativeTrace> {
  return (start) => {
    if (!spans) return null;
    const key = spans.key("session");
    const sessionId = spans.spanIdOf(key);
    spans.start({
      key,
      operation: SpanOperation.Session,
      attributes: sessionAttributes(start, sessionId),
    });
    let open = true;
    let finish: () => Attributes = () => ({});
    return {
      sessionId,
      watch(opened, tracing) {
        const entries = traceAgent(opened.session, spans, start.agent, {
          sessionId,
          ...tracing,
          processes: opened.processes,
        });
        finish = () => ({
          "kanthord.session.entry_count": entries(),
          ...redactionAttributes(opened.redaction),
        });
      },
      end(status) {
        if (!open) return;
        open = false;
        spans.end(sessionId, { status, attributes: finish() });
      },
    };
  };
}

function nativeAgent(
  opened: PortSession<NativeTrace>,
  input: NativeAgentInput,
  record: (sent: TurnPrompt) => void,
): NativeAgent {
  const { budget, knownSecrets: secrets } = input;
  const { context, pins, redaction, trace } = opened;
  const { templates } = input.request.setup;
  const recordSend = (work: WorkPrompt, template: PromptTemplate) =>
    record({
      template,
      template_digest: digest(templates[template]),
      work_digest: work.digest,
    });
  let session: AgentSession | null = opened.session;
  const finishTurn = opened.session.agent.finishTurn;
  opened.session.agent.finishTurn = async (turn, signal) => {
    if (budget.exhaustedAfterTurn()) return { action: "end" };
    return (await finishTurn?.(turn, signal)) ?? undefined;
  };
  const settle = async (text: string) => {
    assert.ok(session);
    try {
      await session.prompt(text, { expandPromptTemplates: false });
    } catch (error) {
      if (context.signal.aborted) throw error;
      throw await promptStop(error, secrets);
    }
    await session.waitForIdle();
    if (context.signal.aborted) return;
    const failed = await providerFailure(session.messages, secrets);
    if (failed) throw failed;
  };
  let unsubscribeTurns: (() => void) | null = countTurns(opened.session, () => {
    budget.turnEnded();
    if (budget.exhausted()) void session?.abort();
  });
  let cancellation: Disposable | null = addAbortListener(context.signal, () => {
    void session?.abort();
  });
  return {
    budget,
    async prompt(work) {
      assert.ok(session);
      context.signal.throwIfAborted();
      const redacted = await redactedWork(redaction, work);
      pins.setWork(redacted);
      recordSend(work, PromptTemplate.Work);
      await settle(redacted.text);
    },
    async abort() {
      await session?.abort();
    },
    async instruct(work, text, template) {
      assert.ok(session);
      context.signal.throwIfAborted();
      pins.setWork(await redactedWork(redaction, work));
      recordSend(work, template);
      await settle(await redaction.text(text));
    },
    lastText() {
      assert.ok(session);
      const text = session.getLastAssistantText();
      return text === undefined ? undefined : redaction.modelOutput(text);
    },
    completeReply() {
      assert.ok(session);
      return isCompleteReply(session.messages);
    },
    closeTrace(status) {
      if (session) trace?.end(status);
    },
    async close() {
      if (session) trace?.end(SpanStatus.Ok);
      unsubscribeTurns?.();
      cancellation?.[Symbol.dispose]();
      unsubscribeTurns = null;
      cancellation = null;
      session = null;
      await opened.close();
    },
  };
}

async function redactedWork(
  redaction: SensitiveTextRedaction,
  work: WorkPrompt,
): Promise<WorkPrompt> {
  return { ...work, text: await redaction.text(work.text) };
}

function appendPinnedContext(session: AgentSession): void {
  session.sessionManager.appendCustomEntry(PINNED_CONTEXT_TYPE, {
    part: PinnedContextPart.SystemPrompt,
  });
}

export async function openNativeAgent(
  input: NativeAgentInput,
): Promise<NativeAgent> {
  const { request } = input;
  assert.equal(request.claim.execution_id, request.setup.execution_id);
  const secrets = input.knownSecrets;
  const opened = await input.sessions.open(request, input.context);
  let sent: TurnPrompt | null = null;
  try {
    appendPinnedContext(opened.session);
    if (opened.trace)
      opened.trace.watch(opened, {
        secrets: await secrets(),
        refreshSecrets: secrets,
        promptOf: () => sent,
      });
    return nativeAgent(opened, input, (prompt) => {
      sent = prompt;
    });
  } catch (error) {
    opened.trace?.end(SpanStatus.Error);
    await opened.close();
    throw error;
  }
}
