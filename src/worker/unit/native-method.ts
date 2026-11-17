import assert from "node:assert/strict";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { type NativeAgent, openNativeAgent } from "./native-agent.ts";
import {
  credentialSecrets,
  mergedSecrets,
} from "../../agent/hooks/sensitive-text-redaction.ts";
import type { TelemetrySink } from "./telemetry.ts";
import type { Context } from "../../kernel/context.ts";
import type { Diagnostic } from "../../kernel/errors.ts";
import { type MethodClaim, ExecutionRun as Run } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  ExecutionIntent,
  type ExecutionSetup,
  type HostTools,
  type RepositoryTransport,
  WorkerMethod,
} from "../contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { getWorkerDeclaration } from "../catalog.ts";
import type { WorkspaceRoot } from "./workspace.ts";
import type {
  ExecutionCredential,
  ModelRuntimeFactory,
} from "./model-runtime.ts";
import { ExecutionBudget } from "./budget.ts";
import { readPinnedRevision } from "./node-reads.ts";
import type { Chain } from "./chain.ts";
import { evaluationChain } from "./chain-evaluation.ts";
import { examineChain } from "./chain-examine.ts";
import { implementChain } from "./chain-implement.ts";
import { executionBoundary, runChain } from "./chain-runner.ts";
import { workerPorts } from "./worker-ports.ts";

export type { ExecutionEnd } from "./execution-run.ts";
export { executionBoundary } from "./chain-runner.ts";
const WORKING_AGENT = 0;
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
  stop?: Context;
  log?: (record: Record<string, unknown>) => void;
  telemetry?: TelemetrySink;
}

export async function runNativeExecution(
  input: NativeExecutionInput,
): Promise<ExecutionEnd> {
  const secrets = mergedSecrets(
    input.credentials.items.map((item) =>
      credentialSecrets(item.store, item.provider_id),
    ),
  );
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
          knownSecrets: secrets,
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
      return runChain(
        chainOf(method, intent),
        {
          seed: {
            claim: input.claim,
            setup: input.setup,
            sshAccess: input.sshAccess,
            revision,
          },
        },
        {
          run,
          budget,
          resources: new AsyncDisposableStack(),
          host: {
            workspaces: input.workspaces,
            transport: input.transport,
            env: input.env,
            openAgent: open,
          },
          ports: workerPorts(input, run),
        },
      );
    });
  } finally {
    try {
      for (const agent of [...opened.keys()]) close(agent);
    } finally {
      run.dispose();
    }
  }
}

export type SetupRefusalInput = Pick<
  NativeExecutionInput,
  "claim" | "clients" | "credentials" | "context" | "log" | "telemetry"
>;

export async function releaseSetupRefusal(
  input: SetupRefusalInput,
  refusal: Diagnostic,
): Promise<ExecutionEnd> {
  const run = new Run(input);
  try {
    return await executionBoundary(run, async () => {
      throw refusal;
    });
  } finally {
    run.dispose();
  }
}

function chainOf(method: WorkerMethod, intent: ExecutionIntent): Chain {
  if (method === WorkerMethod.Evaluation) return evaluationChain();
  if (intent === ExecutionIntent.Examine) return examineChain();
  return implementChain();
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

export function disposeAgent(agent: NativeAgent | null): void {
  if (!agent) return;
  agent.dispose();
}

export function stopOnEnd(run: ExecutionRun, agent: NativeAgent): Disposable {
  return run.onStop(() => void agent.abort());
}
