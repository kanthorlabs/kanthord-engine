import assert from "node:assert/strict";
import type { ExecutionRun } from "./execution-run.ts";
import { EndReason, type ExecutionEnd } from "./execution-stop.ts";
import { nativeSessionTrace, openNativeAgent } from "./native-agent.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import {
  credentialSecrets,
  mergedSecrets,
} from "../../agent/hooks/sensitive-text-redaction.ts";
import { agentPort, type SessionModelFactory } from "../../agent/agent-port.ts";
import { executionEvidence } from "../../agent/capabilities/execution-evidence.ts";
import { linkUpdates } from "../../agent/capabilities/link-updates.ts";
import type { SessionHostTools } from "../../agent/capabilities/host-tools.ts";
import type { TelemetrySink } from "./telemetry.ts";
import type { Context } from "../../kernel/context.ts";
import type { Diagnostic } from "../../kernel/errors.ts";
import { ExecutionRun as Run } from "./execution-run.ts";
import type { MethodClaim } from "./execution-stop.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  ExecutionIntent,
  type ExecutionSetup,
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
import {
  type ChainIo,
  executionBoundary,
  runChain,
  type WalkInput,
} from "./chain-runner.ts";
import type { AgentOpenRequest, CommonPorts } from "./foundry-ports.ts";
import {
  type AgentHost,
  evaluationPorts,
  examinePorts,
  implementHostPorts,
} from "./worker-ports.ts";

export type { ExecutionEnd } from "./execution-stop.ts";
export { executionBoundary } from "./chain-runner.ts";
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
  hostTools: SessionHostTools;
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
  const close = async (agent: NativeAgent) => {
    const unlink = opened.get(agent);
    if (!unlink) return;
    opened.delete(agent);
    try {
      await disposeAgent(agent);
    } finally {
      unlink[Symbol.dispose]();
    }
  };
  const capabilities = [
    executionEvidence(input.hostTools),
    linkUpdates(input.hostTools),
  ];
  const sessions = agentPort({
    capabilities,
    modelRuntimeFactory: modelFactoryOf(input),
    knownSecrets: secrets,
    trace: nativeSessionTrace(run.spans),
    sessionRoot: input.sessionRoot ?? null,
    budget,
    env: input.env,
    hostHome: input.hostHome,
  });
  try {
    return await executionBoundary(run, async () => {
      await secrets();
      const method = getWorkerDeclaration(input.setup.worker_name)?.method;
      if (!method) return run.stop(EndReason.OperationFailed);
      const revision = await readPinnedRevision(run);
      const intent = input.setup.intent;
      const open = async (request: AgentOpenRequest) => {
        const native = await openNativeAgent({
          sessions,
          request,
          budget,
          knownSecrets: secrets,
          context: run.operationContext,
          turnCheck: () => run.checkClaim(),
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
      const hosted = hostedChainOf(method, intent, {
        input,
        agent: { run, budget, open },
      });
      return hosted(
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
          capabilities,
          resources: new AsyncDisposableStack(),
          host: {
            workspaces: input.workspaces,
            transport: input.transport,
            env: input.env,
          },
        },
      );
    });
  } finally {
    try {
      for (const agent of [...opened.keys()]) await close(agent);
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

interface ChainHost {
  input: NativeExecutionInput;
  agent: AgentHost;
}

type HostedChain = (
  input: WalkInput,
  io: Omit<ChainIo, "ports">,
) => Promise<ExecutionEnd>;

function hostedOf<P extends CommonPorts>(
  built: Chain<P>,
  ports: NoInfer<P>,
): HostedChain {
  return (input, io) => runChain(built, input, { ...io, ports });
}

function hostedChainOf(
  method: WorkerMethod,
  intent: ExecutionIntent,
  host: ChainHost,
): HostedChain {
  const { input, agent } = host;
  if (method === WorkerMethod.Evaluation)
    return hostedOf(evaluationChain(), evaluationPorts(agent));
  if (intent === ExecutionIntent.Examine)
    return hostedOf(examineChain(), examinePorts(agent));
  return hostedOf(implementChain(), implementHostPorts(input, agent));
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

function modelFactoryOf(input: NativeExecutionInput): SessionModelFactory {
  return ({ agent, signal }) => {
    const credential = input.credentials.items.find(
      (item) => item.credential_id === agent.credential_id,
    );
    assert.ok(credential);
    return input.modelRuntimeFactory({ credential, agent, signal });
  };
}

export async function disposeAgent(agent: NativeAgent | null): Promise<void> {
  if (!agent) return;
  await agent.close();
}

export function stopOnEnd(run: ExecutionRun, agent: NativeAgent): Disposable {
  return run.onStop(() => void agent.abort());
}
