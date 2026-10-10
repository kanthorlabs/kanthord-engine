import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  abortSignal,
  throwIfCancelled,
  type Context,
  type CancellationContext,
} from "../kernel/context.ts";
import type { AgentSetup, ExecutionSetup, HostTools } from "./contract.ts";
import type { ExecutionBudget } from "./budget.ts";
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
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";

export const NodeKind = {
  Objective: "objective",
  Initiative: "initiative",
} as const;
export type NodeKind = (typeof NodeKind)[keyof typeof NodeKind];
export interface NativeAgentInput {
  setup: ExecutionSetup;
  claim: {
    execution_id: string;
    node_id: string;
    created_at: number;
    expired_at: number;
  };
  nodeKind: NodeKind;
  agent: AgentSetup;
  credential: ExecutionCredential;
  budget: ExecutionBudget;
  workspaceAgentFiles: boolean;
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
  const finishTurn = opened.agent.finishTurn;
  opened.agent.finishTurn = async (turn, signal) =>
    budget.exhaustedAfterTurn()
      ? { action: "end" }
      : ((await finishTurn?.(turn, signal)) ?? undefined);
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
  assert.equal(input.claim.execution_id, input.setup.execution_id);
  assert.equal(input.credential.credential_id, input.agent.credential_id);
  const budget = input.budget;
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
            workspace: input.workspaceAgentFiles ? input.workspace : null,
            hostHome: input.hostHome,
            context,
          }),
        ]
      : [];
    const { runtime, model } = await withDeadline(
      input.modelRuntimeFactory({
        credential: input.credential,
        agent: input.agent,
        signal: bridge.signal,
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
      ),
      hostHome: input.hostHome,
      hooks: [pins.hook],
      context,
    });
    pins.pinInference(session, input.agent.prompt.final);
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
