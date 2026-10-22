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
import type {
  CompositionRecord,
  WorkPrompt,
} from "../../agent/prompt-composer.ts";
import { resolveRepositoryLayer } from "../../agent/prompt-layers.ts";
import { compositionRecord, workingTexts } from "../../agent/prompt-render.ts";
import { openSession, withDeadline } from "../../agent/agent-session.ts";
import { countTurns, pinnedLayers } from "../../agent/pinned-layers.ts";
import { loadPi } from "../../agent/pi.ts";
import { sessionTools } from "./tool-table.ts";
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { providerFailureOf } from "../../llm/provider-failure.ts";
import { redactReason, thrownReason } from "../../kernel/probe.ts";
import { CodedError } from "../../kernel/errors.ts";
import { SecretShape } from "../../custody/contract.ts";
import { traceAgent } from "./agent-telemetry.ts";
import type { SpanRecorder } from "./telemetry.ts";

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
  workspaceAgentFiles: boolean;
  workspace: string;
  checkouts: readonly string[];
  hostHome: string;
  env: NodeJS.ProcessEnv;
  modelRuntimeFactory: ModelRuntimeFactory;
  hostTools: HostTools;
  context: Context;
  turnCheck?: () => Promise<void>;
  spans?: SpanRecorder;
}
export interface NativeAgent {
  prompt(work: WorkPrompt): Promise<void>;
  instruct(work: WorkPrompt, text: string): Promise<void>;
  lastText(): string | undefined;
  transcript(): readonly unknown[];
  abort(): Promise<void>;
  readonly budget: ExecutionBudget;
  readonly composition: CompositionRecord;
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

function nativeAgent(
  opened: AgentSession,
  pins: ReturnType<typeof pinnedLayers>,
  budget: ExecutionBudget,
  composition: CompositionRecord,
  context: CancellationContext,
  turnCheck: () => Promise<void>,
  unsubscribeTrace: () => void,
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
    composition,
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
    transcript() {
      assert.ok(session);
      return [...session.messages];
    },
    dispose() {
      unsubscribeTrace();
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

export async function openNativeAgent(
  input: NativeAgentInput,
): Promise<NativeAgent> {
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  assert.equal(input.credential.credential_id, input.agent.credential_id);
  const budget = input.budget;
  const context = budget.agentContext(input.context);
  let session: AgentSession | undefined;
  const secrets = credentialRedaction(input.credential);
  try {
    await secrets();
    const layers = [];
    for (const [index, repository] of input.setup.repositories.entries())
      layers.push(
        await resolveRepositoryLayer({
          repository: {
            name: repository.name,
            project_prompt: repository.project_prompt,
            working_layer: repository.working_layer,
          },
          workspace: input.workspaceAgentFiles
            ? (input.checkouts[index] ?? null)
            : null,
          hostHome: input.hostHome,
          context,
        }),
      );
    const { runtime, model } = await withDeadline(
      input.modelRuntimeFactory({
        credential: input.credential,
        agent: input.agent,
        signal: context.signal,
      }),
      context,
    );
    const pins = pinnedLayers(workingTexts(layers, input.setup.templates));
    const pi = await withDeadline(loadPi(), context);
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
      ),
      hostHome: input.hostHome,
      hooks: [pins.hook],
      context,
    });
    pins.pinInference(session, input.agent.prompt.final);
    const unsubscribeTrace = input.spans
      ? traceAgent(session, input.spans, input.agent)
      : () => {};
    return nativeAgent(
      session,
      pins,
      budget,
      compositionRecord(layers),
      context,
      input.turnCheck ?? (async () => {}),
      unsubscribeTrace,
      secrets,
    );
  } catch (error) {
    session?.dispose();
    context.cancel();
    throw error;
  }
}
