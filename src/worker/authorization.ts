import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { Transaction } from "../kernel/store.ts";
import { approvedModels } from "../llm/platforms.ts";
import type { ApprovedModelsFn } from "../agent/contract.ts";
import {
  AuthorizationRefusal,
  type SchedulerClaims,
  WorkerErrorCode,
} from "./contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";

const NO_AGENTS = 0;

function refused(reason: AuthorizationRefusal): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    WorkerErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason },
  );
}

type ModelInferenceDependencies = Pick<
  Dependencies,
  "workerBindingRowOf" | "pinnedCredentialMetadata" | "credentialMetadata"
> & {
  schedulerClaims: Pick<SchedulerClaims, "agentSelectionsOf">;
};
type BindingRow = ReturnType<Dependencies["workerBindingRowOf"]>;
type ModelInferenceExecution = {
  execution_id: string;
  project_id: string;
  worker_binding_id: string;
  resource_identity: string;
};
type AgentSelections = ReturnType<SchedulerClaims["agentSelectionsOf"]>;
type AgentAuthorizationScope = {
  worker: Pick<WorkerService, "pinnedAgentView">;
  tx: Transaction;
  workerName: string;
  selections: AgentSelections;
  pinnedModels: ApprovedModelsFn;
};

function boundRowOf(
  row: BindingRow,
  execution: ModelInferenceExecution,
  identity: MachineIdentity,
): NonNullable<BindingRow> {
  if (
    !row ||
    row.project_id !== execution.project_id ||
    row.project_id !== identity.projectId ||
    row.resource_identity !== execution.resource_identity ||
    row.resource_identity !== identity.resourceIdentity
  )
    refused(AuthorizationRefusal.BindingMismatch);
  return row;
}

function pinnedModelsOf(
  dependencies: ModelInferenceDependencies,
  claim: { executionId: string; runtimeIdentity: string },
): ApprovedModelsFn {
  return (transaction, name) => {
    const record =
      dependencies.pinnedCredentialMetadata(
        transaction,
        claim,
        name,
        Date.now(),
      ) ?? dependencies.credentialMetadata(transaction, name);
    return record && approvedModels(record.platform, record.metadata);
  };
}

function authorizeAgent(agent: string, scope: AgentAuthorizationScope) {
  const selection = scope.selections.find(
    ({ agent_name }) => agent_name === agent,
  );
  assert.ok(
    selection,
    "A native agent of a claimed execution must hold a pin.",
  );
  const view = scope.worker.pinnedAgentView(
    scope.tx,
    scope.workerName,
    selection,
    scope.pinnedModels,
  );
  assert.ok(view);
  if (!view.valid) {
    const issue = view.issues[0];
    assert.ok(issue);
    throw new OperationError(
      HttpStatus.BadRequest,
      issue.code,
      "The agent configuration is not valid.",
      { issues: view.issues },
    );
  }
  assert.ok(view.effective);
  return {
    credential: view.effective.credential,
    platform: view.effective.provider,
    provider_id: piProviderId(view.effective.provider),
    agent_provider: view.effective.agent_provider,
  };
}

export function authorizeModelInference(
  dependencies: ModelInferenceDependencies,
  worker: Pick<WorkerService, "declarationOf" | "pinnedAgentView">,
  tx: Transaction,
  identity: MachineIdentity,
  execution: ModelInferenceExecution,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(execution.execution_id);
  const row = boundRowOf(
    dependencies.workerBindingRowOf(tx, execution.worker_binding_id),
    execution,
    identity,
  );
  if (row.tombstone) refused(AuthorizationRefusal.BindingRemoved);
  const agents = worker.declarationOf(row.worker_name)?.agent_names ?? [];
  if (row.disabled && agents.length === NO_AGENTS)
    refused(AuthorizationRefusal.BindingDisabled);
  const selections = dependencies.schedulerClaims.agentSelectionsOf(
    tx,
    execution.execution_id,
  );
  if (agents.length === NO_AGENTS) refused(AuthorizationRefusal.NoNativeAgent);
  assert.ok(identity.runtimeIdentity);
  const claim = {
    executionId: execution.execution_id,
    runtimeIdentity: identity.runtimeIdentity,
  };
  const scope: AgentAuthorizationScope = {
    worker,
    tx,
    workerName: row.worker_name,
    selections,
    pinnedModels: pinnedModelsOf(dependencies, claim),
  };
  const authorizations = agents.map((agent) => authorizeAgent(agent, scope));
  return authorizations.filter(
    (item, index) =>
      authorizations.findIndex(
        (other) => other.credential === item.credential,
      ) === index,
  );
}
