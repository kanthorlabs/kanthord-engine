import assert from "node:assert/strict";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  abortSignal,
  throwIfCancelled,
  type Context,
  type CancellationContext,
} from "../kernel/context.ts";
import { type ExecutionSetup, type WorkerMethod } from "./contract.ts";
import { ExecutionBudget } from "./budget.ts";
import {
  composePrompt,
  type CompositionRecord,
  type WorkPrompt,
} from "./prompt-composer.ts";
import { getAgentDeclaration } from "./catalog.ts";
import { openSession, withDeadline } from "./agent-session.ts";
import { countTurns, pinnedLayers } from "./pinned-layers.ts";
import { loadPi } from "./pi.ts";
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
  handoverItem: { credentialId: string; providerId: string };
  workspace: string;
  hostHome: string;
  modelRuntimeFactory: ModelRuntimeFactory;
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
      await session.prompt(work.marked, { expandPromptTemplates: false });
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
  assert.equal(input.claim.executionId, input.setup.executionId);
  const budget = new ExecutionBudget({
    ...input.claim,
    resourceBudget: input.setup.resourceBudget,
  });
  const context = budget.agentContext(input.context);
  const bridge = abortSignal(context);
  let session: AgentSession | undefined;
  try {
    const agent = getAgentDeclaration(input.setup.agentName);
    assert.ok(agent);
    const composed = await composePrompt(
      {
        workerName: input.setup.workerName,
        agent,
        method: input.method,
        globalPrompt: input.setup.globalPrompt,
        hostHome: input.hostHome,
        repository:
          input.nodeKind === NodeKind.Objective
            ? (input.setup.repositories[0] ?? null)
            : null,
        workspace: input.workspace,
      },
      context,
    );
    const { runtime, model } = await withDeadline(
      input.modelRuntimeFactory({
        credentials: input.credentials,
        handoverItem: input.handoverItem,
        setup: input.setup,
        signal: bridge.signal,
      }),
      context,
    );
    const pins = pinnedLayers(composed.layers);
    const pi = await withDeadline(loadPi(), context);
    session = await openSession({
      cwd: input.workspace,
      modelRuntime: runtime,
      model,
      thinkingLevel: input.setup.effectiveConfiguration.reasoningEffort,
      systemPrompt: composed.systemPrompt,
      ...sessionTools(pi, input.setup.agentName, input.workspace, budget),
      extensions: [pins.extension],
      context,
    });
    pins.pinInference(session, composed.systemPrompt);
    return nativeAgent(
      session,
      pins,
      budget,
      composed.record,
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
