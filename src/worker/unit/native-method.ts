import assert from "node:assert/strict";
import {
  EndReason,
  ExecutionEndKind,
  type ExecutionStop,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import {
  credentialRedaction,
  openNativeAgent,
  type NativeAgent,
} from "./native-agent.ts";
import { Phase, type SpanEnd, type TelemetrySink } from "./telemetry.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import type { Revision } from "../../mission/contract.ts";
import { verificationCommands } from "./evaluation-input.ts";
import type { Context } from "../../kernel/context.ts";
import { ExecutionRun as Run, type MethodClaim } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  ExecutionIntent,
  WorkerMethod,
  type ExecutionSetup,
  type RepositoryTransport,
  type HostTools,
} from "../contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { getWorkerDeclaration } from "../catalog.ts";
import { WorkspaceKind, type WorkspaceRoot } from "./workspace.ts";
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";
import { ExecutionBudget } from "./budget.ts";
import { readPrior, readPinnedRevision } from "./node-reads.ts";
import { prepareStepsWorkspace, runStepsImplement } from "./steps-implement.ts";
import { runStepsExamine } from "./steps-examine.ts";
import { runEvaluation } from "./evaluation.ts";
import { phaseSpan } from "./method-telemetry.ts";

export type { ExecutionEnd } from "./execution-run.ts";
const WORKING_AGENT = 0;
const NODE_TASK_COUNT = "kanthord.node.task_count";
const NODE_VERIFICATION_COUNT = "kanthord.node.verification_count";
const NODE_BINDING_COUNT = "kanthord.node.binding_count";
export interface NativeExecutionInput {
  claim: MethodClaim;
  setup: ExecutionSetup;
  clients: MethodClients;
  credentials: {
    items: readonly ExecutionCredential[];
    release(): Promise<void>;
  };
  transport: RepositoryTransport;
  sshAccess: ReadonlyMap<string, SshAccess>;
  workspaces: WorkspaceRoot;
  hostHome: string;
  env: NodeJS.ProcessEnv;
  modelRuntimeFactory: ModelRuntimeFactory;
  sessionRoot?: string;
  hostTools: (workspace: string) => HostTools;
  context: Context;
  log?: (record: Record<string, unknown>) => void;
  telemetry?: TelemetrySink;
}

export async function runNativeExecution(
  input: NativeExecutionInput,
): Promise<ExecutionEnd> {
  const secrets = runSecrets(input.credentials.items);
  const run = new Run({
    ...input,
    workerName: input.setup.worker_name,
    secrets,
    environmentDigests: environmentDigestsOf(input.setup.repositories),
  });
  const opened = new Map<NativeAgent, Disposable>();
  const budget = new ExecutionBudget({
    ...input.claim,
    resource_budget: input.setup.resource_budget,
  });
  const close = (agent: NativeAgent) => {
    const unlink = opened.get(agent);
    if (!unlink) return;
    opened.delete(agent);
    try {
      disposeAgent(agent);
    } finally {
      unlink[Symbol.dispose]();
    }
  };
  try {
    return await executionBoundary(run, async () => {
      await secrets();
      const method = getWorkerDeclaration(input.setup.worker_name)?.method;
      if (!method) return run.stop(EndReason.OperationFailed);
      const revision = await readPinnedRevision(run);
      const intent = input.setup.intent;
      const open = async (workspace: string) => {
        const agent = input.setup.agents[WORKING_AGENT];
        assert.ok(agent);
        const credential = input.credentials.items.find(
          (item) => item.credential_id === agent.credential_id,
        );
        assert.ok(credential);
        const native = await openNativeAgent({
          setup: input.setup,
          claim: input.claim,
          intent,
          agent,
          credential,
          budget,
          workspace,
          hostHome: input.hostHome,
          env: input.env,
          modelRuntimeFactory: input.modelRuntimeFactory,
          hostTools: input.hostTools(workspace),
          context: run.operationContext,
          turnCheck: () => run.checkClaim(),
          spans: run.spans,
          sessionRoot: input.sessionRoot,
        });
        const stop = stopOnEnd(run, native);
        const trace = run.onTraceClose((status) => native.closeTrace(status));
        const combined: Disposable = {
          [Symbol.dispose]() {
            try {
              stop[Symbol.dispose]();
            } finally {
              trace[Symbol.dispose]();
            }
          },
        };
        opened.set(native, combined);
        return native;
      };
      if (method === WorkerMethod.Evaluation)
        return runEvaluation(input, run, budget, open);
      if (intent === ExecutionIntent.Examine)
        return runStepsExamine(input, run, revision, budget, open);
      const prior = await readPrior(run, input.setup.repositories);
      const workspace = await run.spans.within(
        phaseSpan(Phase.Prepare),
        () => prepareStepsWorkspace(input, run),
        () => nodeShapeEnd(revision),
      );
      let working: NativeAgent;
      try {
        working = await open(workspace.root);
      } catch (error) {
        input.workspaces.release(
          input.workspaces.nodeKey(input.claim.node_id),
          WorkspaceKind.Node,
        );
        throw error;
      }
      const state = {
        input,
        run,
        revision,
        agent: working,
        ...workspace,
        verdict: prior.verdict,
        cleared: prior.cleared,
        unchangedTurns: 0,
        lastVerification: null,
        revisionCount: 0,
      };
      return runStepsImplement(state);
    });
  } finally {
    try {
      for (const agent of [...opened.keys()]) close(agent);
    } finally {
      run.dispose();
    }
  }
}

function nodeShapeEnd(revision: Revision): SpanEnd {
  return {
    status: SpanStatus.Ok,
    attributes: {
      [NODE_TASK_COUNT]: revision.tasks.length,
      [NODE_VERIFICATION_COUNT]: verificationCommands(revision).length,
      [NODE_BINDING_COUNT]: revision.content.bindings.length,
    },
  };
}

export function environmentDigestsOf(
  repositories: NativeExecutionInput["setup"]["repositories"],
): Record<string, string> {
  return Object.fromEntries(
    repositories.flatMap((repository) =>
      repository.environment === null || !("digest" in repository.environment)
        ? []
        : [[repository.resource_identity, repository.environment.digest]],
    ),
  );
}

function runSecrets(
  items: readonly ExecutionCredential[],
): () => Promise<readonly string[]> {
  const redactions = items.map(credentialRedaction);
  return async () =>
    (await Promise.all(redactions.map((redaction) => redaction()))).flat();
}

export function disposeAgent(agent: NativeAgent | null): void {
  if (!agent) return;
  agent.dispose();
}

export function stopOnEnd(run: ExecutionRun, agent: NativeAgent): Disposable {
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
    stopped = await run.stopOf(error);
  }
  if (stopped.reason !== EndReason.Revoked) return run.releaseStop(stopped);
  return {
    kind: ExecutionEndKind.Ended,
    reason: stopped.reason,
    code: stopped.code,
  };
}
