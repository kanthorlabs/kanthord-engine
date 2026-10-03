import { CodedError } from "../kernel/errors.ts";
import {
  EndReason,
  ExecutionEndKind,
  ExecutionStop,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { NodeKind, openNativeAgent, type NativeAgent } from "./native-agent.ts";
import type { TranscriptSink } from "./transcript.ts";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { Context } from "../kernel/context.ts";
import { ExecutionRun as Run, type MethodClaim } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  WorkerMethod,
  type ExecutionSetup,
  type RepositoryTransport,
  type HostTools,
} from "./contract.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import { WorkspaceKind, type WorkspaceRoot } from "./workspace.ts";
import type { ModelRuntimeFactory } from "./model-runtime.ts";
import {
  nodeKindOf,
  readClearedOutcome,
  readPinnedRevision,
} from "./node-reads.ts";
import { prepareStepsWorkspace, runStepsObjective } from "./steps-objective.ts";
import { runStepsInitiative } from "./steps-initiative.ts";
import { runEvaluation } from "./evaluation.ts";

export type { ExecutionEnd } from "./execution-run.ts";
export interface NativeExecutionInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  clients: MethodClients;
  credentials: { store: CredentialStore; release(): Promise<void> };
  handoverItem: { credentialId: string; providerId: string };
  transport: RepositoryTransport;
  workspaces: WorkspaceRoot;
  hostHome: string;
  modelRuntimeFactory: ModelRuntimeFactory;
  transcript: TranscriptSink;
  hostTools: (workspace: string) => HostTools;
  context: Context;
}

export async function runNativeExecution(
  input: NativeExecutionInput,
): Promise<ExecutionEnd> {
  const run = new Run(input);
  let agent: NativeAgent | null = null;
  let unlink: (() => void) | null = null;
  try {
    return await executionBoundary(run, async () => {
      const method = getWorkerDeclaration(input.setup.workerName)?.method;
      if (!method) return run.stop(EndReason.OperationFailed);
      const revision = await readPinnedRevision(run);
      const kind = nodeKindOf(revision);
      await readClearedOutcome(run);
      const open = async (workspace: string) => {
        agent = await openNativeAgent({
          setup: input.setup,
          claim: input.claim,
          nodeKind: kind,
          method,
          credentials: input.credentials.store,
          handoverItem: input.handoverItem,
          workspace,
          hostHome: input.hostHome,
          modelRuntimeFactory: input.modelRuntimeFactory,
          hostTools: input.hostTools(workspace),
          context: run.operationContext,
        });
        unlink = stopOnEnd(run, agent);
        return agent;
      };
      if (method === WorkerMethod.Evaluation)
        return runEvaluation(input, run, open);
      if (kind === NodeKind.Initiative)
        return runStepsInitiative(input, run, revision, open);
      const workspace = await prepareStepsWorkspace(input, run);
      let opened: NativeAgent;
      try {
        opened = await open(workspace.directory);
      } catch (error) {
        input.workspaces.release(
          input.workspaces.objectiveKey(input.claim.nodeId),
          WorkspaceKind.Objective,
        );
        throw error;
      }
      return runStepsObjective({
        input,
        run,
        revision,
        agent: opened,
        ...workspace,
      });
    });
  } finally {
    try {
      disposeAgent(run, agent, input.transcript);
    } finally {
      const unsubscribe = unlink as (() => void) | null;
      unsubscribe?.();
      run.dispose();
    }
  }
}

export function disposeAgent(
  run: ExecutionRun,
  agent: NativeAgent | null,
  transcript: TranscriptSink,
): void {
  if (!agent) return;
  try {
    transcript.record({
      executionId: run.claim.executionId,
      attempt: run.claim.attempt,
      traceId: run.claim.traceId,
      messages: agent.transcript(),
    });
  } finally {
    agent.dispose();
  }
}

export function stopOnEnd(run: ExecutionRun, agent: NativeAgent): () => void {
  return run.onStop(() => void agent.abort());
}

export async function executionBoundary(
  run: ExecutionRun,
  invoke: () => Promise<ExecutionEnd>,
): Promise<ExecutionEnd> {
  try {
    return await invoke();
  } catch (error) {
    if (error instanceof ExecutionStop)
      return {
        kind: ExecutionEndKind.Ended,
        reason: error.reason,
        code: error.code,
      };
    try {
      run.stop(
        EndReason.OperationFailed,
        error instanceof CodedError ? error.code : null,
      );
    } catch (stopped) {
      if (!(stopped instanceof ExecutionStop)) throw stopped;
      return {
        kind: ExecutionEndKind.Ended,
        reason: stopped.reason,
        code: stopped.code,
      };
    }
  }
}
