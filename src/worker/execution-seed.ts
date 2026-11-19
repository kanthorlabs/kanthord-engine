import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import {
  type ExecutionSeed,
  type ExecutionSetup,
  type SeedExecution,
  type SeedNode,
  type SeedSources,
  withoutEnvironmentMaps,
  WorkerErrorCode,
} from "./contract.ts";
import { executionSetup } from "./execution-setup.ts";
import type { AgentPromptFacts } from "./prompt-telemetry.ts";
import type { Dependencies } from "./service.ts";

const EXECUTION_NOT_FOUND = "scheduler.execution.not_found";

type SetupDependencies = Parameters<typeof executionSetup>[0];
type SetupWorker = Parameters<typeof executionSetup>[1];

interface SeedRead {
  execution: SeedExecution;
  node: SeedNode;
}

function seedRead(
  dependencies: Dependencies,
  seeds: SeedSources,
  executionId: string,
): SeedRead {
  return dependencies.store.transaction((tx) => {
    const execution = seeds.executionOf(tx, executionId);
    if (execution === null)
      throw new OperationError(
        HttpStatus.NotFound,
        EXECUTION_NOT_FOUND,
        "Execution not found.",
      );
    const node = seeds.nodeOf(tx, execution);
    if (node === null)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.ExecutionSeedUnavailable,
        "The node of the execution is closed.",
      );
    return { execution, node };
  });
}

function readOnlyPrompts(
  telemetry: Dependencies["promptTelemetry"],
): Dependencies["promptTelemetry"] {
  const composed = new Map<string, AgentPromptFacts>();
  return {
    agentPrompted: (_executionId, facts) =>
      void composed.set(facts.agent_name, facts),
    promptRecordOf: (executionId, agentName) =>
      telemetry.promptRecordOf(executionId, agentName) ??
      composed.get(agentName) ??
      null,
  };
}

export function seedDependencies(
  dependencies: Dependencies,
  seeds: SeedSources,
  execution: SeedExecution,
): SetupDependencies {
  return {
    ...dependencies,
    promptTelemetry: readOnlyPrompts(dependencies.promptTelemetry),
    environmentClaimed: () => {},
    pinnedCredentialMetadata: (tx, _execution, credentialName) =>
      seeds.credentialMetadataOf(tx, execution.credentials, credentialName),
    custodyHandover: {
      ...dependencies.custodyHandover,
      sshPublicKeyOf: (tx, _execution, credentialName) =>
        seeds.sshPublicKeyOf(tx, execution.credentials, credentialName),
    },
  };
}

function claimOf(execution: SeedExecution): ExecutionClaim {
  return {
    executionId: execution.execution_id,
    projectId: execution.project_id,
    nodeId: execution.node_id,
    attempt: execution.attempt,
    pinnedRevision: execution.pinned_revision,
    nodeBranch: execution.node_branch,
    runtimeIdentity: execution.runtime_identity,
    workerBindingId: execution.worker_binding_id,
  };
}

interface HeadsInput {
  setup: ExecutionSetup;
  read: SeedRead;
  caller: CallerContext;
}

async function headsOf(
  dependencies: Dependencies,
  input: HeadsInput,
): Promise<Record<string, string>> {
  const { setup, read, caller } = input;
  const heads: Record<string, string> = {};
  for (const { binding_id } of setup.repositories) {
    const known = read.node.heads[binding_id];
    if (known !== undefined) {
      heads[binding_id] = known;
      continue;
    }
    assert.ok(dependencies.promptBase);
    heads[binding_id] = await dependencies.promptBase.baseCommitOf(
      binding_id,
      caller.context,
    );
  }
  return heads;
}

export interface SeedCall {
  executionId: string;
  caller: CallerContext;
}

export async function executionSeed(
  dependencies: Dependencies,
  worker: SetupWorker,
  input: SeedCall,
): Promise<ExecutionSeed> {
  const { seeds } = dependencies;
  assert.ok(seeds);
  const read = seedRead(dependencies, seeds, input.executionId);
  const { execution } = read;
  const setup = withoutEnvironmentMaps(
    await executionSetup(
      seedDependencies(dependencies, seeds, execution),
      worker,
      {
        ...input.caller,
        execution: claimOf(execution),
        commit: (write) => dependencies.store.transaction(write),
      },
    ),
  );
  return {
    claim: {
      execution_id: execution.execution_id,
      node_id: execution.node_id,
      attempt: execution.attempt,
      pinned_revision: execution.pinned_revision,
      node_branch: execution.node_branch,
      created_at: execution.created_at,
      expired_at: execution.expired_at,
      trace_id: execution.trace_id,
      root_span_id: execution.root_span_id,
    },
    setup,
    revision: read.node.revision,
    heads: await headsOf(dependencies, { setup, read, caller: input.caller }),
  };
}
