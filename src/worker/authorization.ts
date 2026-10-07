import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { AuthorizationRefusal, WorkerErrorCode } from "./contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";

function refused(reason: AuthorizationRefusal): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    WorkerErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason },
  );
}

export function authorizeModelInference(
  dependencies: Pick<Dependencies, "workerBindingRowOf">,
  worker: Pick<WorkerService, "declarationOf" | "workerAgentView">,
  tx: Transaction,
  identity: MachineIdentity,
  execution: {
    execution_id: string;
    project_id: string;
    worker_binding_id: string;
    resource_identity: string;
  },
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(execution.execution_id);
  const row = dependencies.workerBindingRowOf(tx, execution.worker_binding_id);
  if (
    !row ||
    row.projectId !== execution.project_id ||
    row.projectId !== identity.projectId ||
    row.resourceIdentity !== execution.resource_identity ||
    row.resourceIdentity !== identity.resourceIdentity
  )
    refused(AuthorizationRefusal.BindingMismatch);
  if (row.tombstone) refused(AuthorizationRefusal.BindingRemoved);
  if (row.disabled) refused(AuthorizationRefusal.BindingDisabled);
  const agent = worker.declarationOf(row.workerName)?.agentName;
  if (!agent) refused(AuthorizationRefusal.NoNativeAgent);
  const selected = row.entries.find((item) => item.agent === agent);
  const entry = selected
    ? {
        agentProvider: selected.agentProvider,
        modelIdentifier: selected.modelIdentifier,
        reasoningEffort: selected.reasoningEffort,
      }
    : null;
  const view = worker.workerAgentView(tx, row.workerName, agent, entry);
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
    provider_id: view.effective.provider,
    agent_provider: view.effective.agent_provider,
  };
}
