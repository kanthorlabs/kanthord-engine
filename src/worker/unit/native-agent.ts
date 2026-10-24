import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type Context,
  type CancellationContext,
} from "../../kernel/context.ts";
import type {
  AgentSetup,
  ExecutionSetup,
  ExecutionIntent,
  HostTools,
} from "../contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import { openSession, withDeadline } from "../../agent/agent-session.ts";
import { countTurns, pinnedLayers } from "../../agent/pinned-layers.ts";
import { loadPi } from "../../agent/pi.ts";
import { sessionTools, ToolProcesses } from "./tool-table.ts";
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { providerFailureOf } from "../../llm/provider-failure.ts";
import { redactReason, thrownReason } from "../../kernel/probe.ts";
import { CodedError } from "../../kernel/errors.ts";
import { SecretShape } from "../../custody/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import { traceAgent } from "./agent-telemetry.ts";
import {
  SessionFormat,
  SpanOperation,
  type SpanRecorder,
} from "./telemetry.ts";
import { executionSessionDirectory } from "./session-store.ts";
import { PINNED_CONTEXT_TYPE } from "./session-entries.ts";

export interface NativeAgentInput {
  setup: ExecutionSetup;
  claim: {
    execution_id: string;
    node_id: string;
    created_at: number;
    expired_at: number;
  };
  intent: ExecutionIntent;
  agent: AgentSetup;
  credential: ExecutionCredential;
  budget: ExecutionBudget;
  workspace: string;
  hostHome: string;
  env: NodeJS.ProcessEnv;
  modelRuntimeFactory: ModelRuntimeFactory;
  hostTools: HostTools;
  context: Context;
  turnCheck?: () => Promise<void>;
  spans?: SpanRecorder;
  sessionRoot?: string;
}
export interface NativeAgent {
  prompt(work: WorkPrompt): Promise<void>;
  instruct(work: WorkPrompt, text: string): Promise<void>;
  lastText(): string | undefined;
  abort(): Promise<void>;
  readonly budget: ExecutionBudget;
  closeTrace(status: SpanStatus): void;
  dispose(): void;
}

const ASSISTANT_ROLE = "assistant";
const PROVIDER_ERROR = "error";

async function credentialSecrets(
  credential: ExecutionCredential,
): Promise<string[]> {
  const stored = await credential.store.read(credential.provider_id);
  if (stored === undefined) return [];
  if (stored.type === SecretShape.OAuth) return [stored.access, stored.refresh];
  return stored.key === undefined ? [] : [stored.key];
}

export type CredentialRedaction = () => Promise<readonly string[]>;

export function credentialRedaction(
  credential: ExecutionCredential,
): CredentialRedaction {
  const seen = new Set<string>();
  return async () => {
    for (const secret of await credentialSecrets(credential)) seen.add(secret);
    return [...seen];
  };
}

export async function promptStop(
  error: unknown,
  secrets: CredentialRedaction,
): Promise<unknown> {
  if (error instanceof ExecutionStop) return error;
  return new ExecutionStop(
    EndReason.OperationFailed,
    error instanceof CodedError ? error.code : null,
    thrownReason(error, await secrets()),
  );
}

async function providerFailure(
  messages: readonly AgentMessage[],
  secrets: CredentialRedaction,
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
    detail || null,
  );
}

interface SessionTrace {
  watch(finish: () => number): void;
  end(status: SpanStatus): void;
}

function sessionTrace(spans: SpanRecorder, spanId: string): SessionTrace {
  let open = true;
  let finish: () => number | undefined = () => undefined;
  return {
    watch(next) {
      finish = next;
    },
    end(status) {
      if (!open) return;
      open = false;
      const entryCount = finish();
      spans.end(spanId, {
        status,
        attributes:
          entryCount === undefined
            ? {}
            : { "kanthord.session.entry_count": entryCount },
      });
    },
  };
}

function nativeAgent(
  opened: AgentSession,
  pins: ReturnType<typeof pinnedLayers>,
  budget: ExecutionBudget,
  context: CancellationContext,
  turnCheck: () => Promise<void>,
  trace: SessionTrace | undefined,
  secrets: CredentialRedaction,
): NativeAgent {
  let session: AgentSession | null = opened;
  const finishTurn = opened.agent.finishTurn;
  opened.agent.finishTurn = async (turn, signal) => {
    if (budget.exhaustedAfterTurn()) return { action: "end" };
    try {
      await turnCheck();
    } catch {
      return { action: "end" };
    }
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
  let unsubscribeTurns: (() => void) | null = countTurns(opened, () => {
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
      pins.setWork(work);
      await settle(work.text);
    },
    async abort() {
      await session?.abort();
    },
    async instruct(work, text) {
      assert.ok(session);
      context.signal.throwIfAborted();
      pins.setWork(work);
      await settle(text);
    },
    lastText() {
      assert.ok(session);
      return session.getLastAssistantText();
    },
    closeTrace(status) {
      if (session) trace?.end(status);
    },
    dispose() {
      if (session) trace?.end(SpanStatus.Ok);
      unsubscribeTurns?.();
      cancellation?.[Symbol.dispose]();
      unsubscribeTurns = null;
      cancellation = null;
      context.cancel();
      session?.dispose();
      session = null;
    },
  };
}

function appendPinnedContext(
  session: AgentSession,
  systemPrompt: string,
): void {
  session.sessionManager.appendCustomEntry(PINNED_CONTEXT_TYPE, {
    part: "system_prompt",
    text: systemPrompt,
  });
}

export async function openNativeAgent(
  input: NativeAgentInput,
): Promise<NativeAgent> {
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  assert.equal(input.credential.credential_id, input.agent.credential_id);
  const budget = input.budget;
  const context = budget.agentContext(input.context);
  let session: AgentSession | undefined;
  let trace: SessionTrace | undefined;
  const secrets = credentialRedaction(input.credential);
  try {
    await secrets();
    const { runtime, model } = await withDeadline(
      input.modelRuntimeFactory({
        credential: input.credential,
        agent: input.agent,
        signal: context.signal,
      }),
      context,
    );
    const pins = pinnedLayers([]);
    const pi = await withDeadline(loadPi(), context);
    let sessionId: string | undefined;
    if (input.spans) {
      const key = input.spans.key("session");
      sessionId = input.spans.spanIdOf(key);
      input.spans.start({
        key,
        operation: SpanOperation.Session,
        attributes: {
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.conversation.id": sessionId,
          "gen_ai.agent.name": input.agent.agent_name,
          "kanthord.agent.name": input.agent.agent_name,
          "kanthord.agent.chain_position": input.agent.position,
          "kanthord.agent.chain_level": input.agent.level,
          "gen_ai.request.model":
            input.agent.effective_configuration.model_identifier,
          "kanthord.session.format": SessionFormat.Pi,
          "kanthord.session.format_version": pi.CURRENT_SESSION_VERSION,
        },
      });
      trace = sessionTrace(input.spans, sessionId);
    }
    const options = sessionId === undefined ? {} : { id: sessionId };
    const sessionManager = input.sessionRoot
      ? pi.SessionManager.create(
          input.workspace,
          executionSessionDirectory(
            input.sessionRoot,
            input.claim.execution_id,
          ),
          options,
        )
      : pi.SessionManager.inMemory(input.workspace, options);
    const processes = new ToolProcesses(pi.getShellConfig());
    session = await openSession({
      cwd: input.workspace,
      modelRuntime: runtime,
      model,
      thinkingLevel: input.agent.effective_configuration.reasoning_effort,
      systemPrompt: input.agent.prompt.final,
      ...sessionTools(
        pi,
        input.agent.agent_name,
        input.workspace,
        budget,
        input.hostTools,
        input.env,
        processes,
      ),
      hostHome: input.hostHome,
      hooks: [pins.hook],
      context,
      sessionManager,
    });
    pins.pinInference(session, input.agent.prompt.final);
    appendPinnedContext(session, input.agent.prompt.final);
    if (input.spans && sessionId !== undefined)
      trace?.watch(
        traceAgent(session, input.spans, input.agent, {
          sessionId,
          secrets: await secrets(),
          refreshSecrets: secrets,
          processes,
        }),
      );
    return nativeAgent(
      session,
      pins,
      budget,
      context,
      input.turnCheck ?? (async () => {}),
      trace,
      secrets,
    );
  } catch (error) {
    trace?.end(SpanStatus.Error);
    session?.dispose();
    context.cancel();
    throw error;
  }
}
