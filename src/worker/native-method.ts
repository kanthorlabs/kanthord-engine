import assert from "node:assert/strict";
import {
  EndReason,
  ExecutionEndKind,
  type ExecutionStop,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { NodeKind, openNativeAgent, type NativeAgent } from "./native-agent.ts";
import type { TranscriptSink } from "./transcript.ts";
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
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";
import { ExecutionBudget } from "./budget.ts";
import { reviewedTaskRunner } from "./reviewed-steps.ts";
import {
  nodeKindOf,
  readPriorRationale,
  readPinnedRevision,
} from "./node-reads.ts";
import { prepareStepsWorkspace, runStepsObjective } from "./steps-objective.ts";
import { runStepsInitiative } from "./steps-initiative.ts";
import { runEvaluation } from "./evaluation.ts";

export type { ExecutionEnd } from "./execution-run.ts";
const WORKING_AGENT = 0;
const REVIEW_AGENT = 1;
export interface NativeExecutionInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  clients: MethodClients;
  credentials: {
    items: readonly ExecutionCredential[];
    release(): Promise<void>;
  };
  transport: RepositoryTransport;
  workspaces: WorkspaceRoot;
  hostHome: string;
  modelRuntimeFactory: ModelRuntimeFactory;
  transcript: TranscriptSink;
  hostTools: (workspace: string) => HostTools;
  context: Context;
  log?: (record: Record<string, unknown>) => void;
}

export async function runNativeExecution(
  input: NativeExecutionInput,
): Promise<ExecutionEnd> {
  const run = new Run(input);
  const opened = new Map<NativeAgent, () => void>();
  const budget = new ExecutionBudget({
    ...input.claim,
    resource_budget: input.setup.resource_budget,
  });
  const close = (agent: NativeAgent) => {
    const unlink = opened.get(agent);
    if (!unlink) return;
    opened.delete(agent);
    try {
      disposeAgent(run, agent, input.transcript);
    } finally {
      unlink();
    }
  };
  try {
    return await executionBoundary(run, async () => {
      const method = getWorkerDeclaration(input.setup.worker_name)?.method;
      if (!method) return run.stop(EndReason.OperationFailed);
      const revision = await readPinnedRevision(run);
      const kind = nodeKindOf(revision);
      const openAgent = async (
        agentIndex: number,
        workspace: string,
        workspaceAgentFiles: boolean,
      ) => {
        const agent = input.setup.agents[agentIndex];
        assert.ok(agent);
        const credential = input.credentials.items.find(
          (item) => item.credential_id === agent.credential_id,
        );
        assert.ok(credential);
        const native = await openNativeAgent({
          setup: input.setup,
          claim: input.claim,
          nodeKind: kind,
          agent,
          credential,
          budget,
          workspaceAgentFiles,
          workspace,
          hostHome: input.hostHome,
          modelRuntimeFactory: input.modelRuntimeFactory,
          hostTools: input.hostTools(workspace),
          context: run.operationContext,
        });
        opened.set(native, stopOnEnd(run, native));
        return native;
      };
      const open = (workspace: string) =>
        openAgent(WORKING_AGENT, workspace, method !== WorkerMethod.Evaluation);
      if (method === WorkerMethod.Evaluation)
        return runEvaluation(input, run, open);
      if (kind === NodeKind.Initiative)
        return runStepsInitiative(input, run, revision, open);
      const priorRationale = await readPriorRationale(run);
      const workspace = await prepareStepsWorkspace(input, run);
      let working: NativeAgent;
      try {
        working = await open(workspace.directory);
      } catch (error) {
        input.workspaces.release(
          input.workspaces.objectiveKey(input.claim.node_id),
          WorkspaceKind.Objective,
        );
        throw error;
      }
      const state = {
        input,
        run,
        revision,
        agent: working,
        ...workspace,
        priorRationale,
      };
      if (method === WorkerMethod.ReviewedSteps)
        return runStepsObjective(
          state,
          reviewedTaskRunner({
            open: (directory) => openAgent(REVIEW_AGENT, directory, false),
            close,
          }),
        );
      return runStepsObjective(state);
    });
  } finally {
    try {
      for (const agent of [...opened.keys()]) close(agent);
    } finally {
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
      executionId: run.claim.execution_id,
      attempt: run.claim.attempt,
      traceId: run.claim.trace_id,
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
  let stopped: ExecutionStop;
  try {
    return await invoke();
  } catch (error) {
    stopped = run.stopOf(error);
  }
  if (stopped.reason !== EndReason.Revoked) return run.releaseStop(stopped);
  return {
    kind: ExecutionEndKind.Ended,
    reason: stopped.reason,
    code: stopped.code,
  };
}
