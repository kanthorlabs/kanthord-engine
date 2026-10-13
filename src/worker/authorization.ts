import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AuthorizationRefusal,
  WorkerErrorCode,
  type SchedulerClaims,
} from "./contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";
import { entryOf, pinnedEntry } from "./agent-selection.ts";

const NO_AGENTS = 0;

function refused(reason: AuthorizationRefusal): never {
  throw new OperationError(
    HttpStatus.Forbidden,
    WorkerErrorCode.AuthorizationRefused,
    "The facility refuses the operation.",
    { reason },
  );
}

export function authorizeModelInference(
  dependencies: Pick<Dependencies, "workerBindingRowOf"> & {
    schedulerClaims: Pick<SchedulerClaims, "agentSelectionsOf">;
  },
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
    row.project_id !== execution.project_id ||
    row.project_id !== identity.projectId ||
    row.resource_identity !== execution.resource_identity ||
    row.resource_identity !== identity.resourceIdentity
  )
    refused(AuthorizationRefusal.BindingMismatch);
  if (row.tombstone) refused(AuthorizationRefusal.BindingRemoved);
  if (row.disabled) refused(AuthorizationRefusal.BindingDisabled);
  const agents = worker.declarationOf(row.worker_name)?.agent_names ?? [];
  const selections = dependencies.schedulerClaims.agentSelectionsOf(
    tx,
    execution.execution_id,
  );
  if (agents.length === NO_AGENTS) refused(AuthorizationRefusal.NoNativeAgent);
  const authorizations = agents.map((agent) => {
    const entry = pinnedEntry(selections, agent, entryOf(row.entries, agent));
    const view = worker.workerAgentView(tx, row.worker_name, agent, entry);
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
  });
  return authorizations.filter(
    (item, index) =>
      authorizations.findIndex(
        (other) => other.credential === item.credential,
      ) === index,
  );
}
