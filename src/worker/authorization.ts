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
    executionId: string;
    projectId: string;
    workerBindingId: string;
    resourceIdentity: string;
  },
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(execution.executionId);
  const row = dependencies.workerBindingRowOf(tx, execution.workerBindingId);
  if (
    !row ||
    row.projectId !== execution.projectId ||
    row.projectId !== identity.projectId ||
    row.resourceIdentity !== execution.resourceIdentity ||
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
    providerId: view.effective.provider,
    agentProvider: view.effective.agentProvider,
  };
}
