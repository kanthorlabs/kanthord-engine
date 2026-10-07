import assert from "node:assert/strict";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  abortSignal,
  throwIfCancelled,
  type Context,
  type CancellationContext,
} from "../kernel/context.ts";
import {
  type ExecutionSetup,
  WorkerMethod,
  type HostTools,
} from "./contract.ts";
import { ExecutionBudget } from "./budget.ts";
import type {
  CompositionRecord,
  WorkPrompt,
} from "../agent/prompt-composer.ts";
import { resolveRepositoryLayer } from "../agent/prompt-layers.ts";
import { compositionRecord, workingTexts } from "../agent/prompt-render.ts";
import { openSession, withDeadline } from "../agent/agent-session.ts";
import { countTurns, pinnedLayers } from "../agent/pinned-layers.ts";
import { loadPi } from "../agent/pi.ts";
import { sessionTools } from "./tool-table.ts";
import type { ModelRuntimeFactory } from "./model-runtime.ts";

export const NodeKind = {
  Objective: "objective",
  Initiative: "initiative",
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];
export interface NativeAgentInput {
  setup: ExecutionSetup;
  claim: {
    executionId: string;
    nodeId: string;
    createdAt: number;
    expiredAt: number;
  };
  nodeKind: NodeKind;
  method: WorkerMethod;
  credentials: CredentialStore;
  handoverItem: { credential_id: string; provider_id: string };
  workspace: string;
  hostHome: string;
  modelRuntimeFactory: ModelRuntimeFactory;
  hostTools: HostTools;
  context: Context;
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

function nativeAgent(
  opened: AgentSession,
  pins: ReturnType<typeof pinnedLayers>,
  budget: ExecutionBudget,
  composition: CompositionRecord,
  context: CancellationContext,
  disposeSignal: () => void,
): NativeAgent {
  let session: AgentSession | null = opened;
  const shouldStopAfterTurn = opened.agent.shouldStopAfterTurn;
  opened.agent.shouldStopAfterTurn = async (turn, signal) =>
    budget.exhausted() || (await shouldStopAfterTurn?.(turn, signal)) === true;
  let unsubscribeTurns: (() => void) | null = countTurns(opened, () => {
    budget.turnEnded();
    if (budget.exhausted()) void session?.abort();
  });
  let unsubscribeCancellation: (() => void) | null = context.onCancel(() => {
    void session?.abort();
  });
  return {
    budget,
    composition,
    async prompt(work) {
      assert.ok(session);
      throwIfCancelled(context);
      pins.setWork(work);
      await session.prompt(work.text, { expandPromptTemplates: false });
      await session.waitForIdle();
    },
    async abort() {
      await session?.abort();
    },
    async instruct(work, text) {
      assert.ok(session);
      throwIfCancelled(context);
      pins.setWork(work);
      await session.prompt(text, { expandPromptTemplates: false });
      await session.waitForIdle();
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
      unsubscribeTurns?.();
      unsubscribeCancellation?.();
      unsubscribeTurns = null;
      unsubscribeCancellation = null;
      disposeSignal();
      context.cancel();
      session?.dispose();
      session = null;
    },
  };
}

export async function openNativeAgent(
  input: NativeAgentInput,
): Promise<NativeAgent> {
  assert.equal(input.claim.executionId, input.setup.execution_id);
  const budget = new ExecutionBudget({
    ...input.claim,
    resourceBudget: input.setup.resource_budget,
  });
  const context = budget.agentContext(input.context);
  const bridge = abortSignal(context);
  let session: AgentSession | undefined;
  try {
    const repository =
      input.nodeKind === NodeKind.Objective
        ? (input.setup.repositories[0] ?? null)
        : null;
    const layers = repository
      ? [
          await resolveRepositoryLayer({
            repository: {
              name: repository.name,
              project_prompt: repository.project_prompt,
              working_layer: repository.working_layer,
            },
            workspace:
              input.method === WorkerMethod.Evaluation ? null : input.workspace,
            hostHome: input.hostHome,
            context,
          }),
        ]
      : [];
    const { runtime, model } = await withDeadline(
      input.modelRuntimeFactory({
        credentials: input.credentials,
        handoverItem: input.handoverItem,
        setup: input.setup,
        signal: bridge.signal,
      }),
      context,
    );
    const pins = pinnedLayers(workingTexts(layers));
    const pi = await withDeadline(loadPi(), context);
    session = await openSession({
      cwd: input.workspace,
      modelRuntime: runtime,
      model,
      thinkingLevel: input.setup.effective_configuration.reasoning_effort,
      systemPrompt: input.setup.prompt.final,
      ...sessionTools(
        pi,
        input.setup.agent_name,
        input.workspace,
        budget,
        input.hostTools,
      ),
      hostHome: input.hostHome,
      hooks: [pins.hook],
      context,
    });
    pins.pinInference(session, input.setup.prompt.final);
    return nativeAgent(
      session,
      pins,
      budget,
      compositionRecord(layers),
      context,
      bridge.dispose,
    );
  } catch (error) {
    session?.dispose();
    context.cancel();
    bridge.dispose();
    throw error;
  }
}
