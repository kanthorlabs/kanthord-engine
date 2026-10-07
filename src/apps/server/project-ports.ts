import type {
  BindingRevisionResult,
  RepositoryPolicy,
  StorageBinding,
  WorkerBindingRow,
} from "../../project/contract.ts";
import type { ProjectService } from "../../project/index.ts";

type WorkerRowView = NonNullable<
  ReturnType<ProjectService["workerBindingRowOf"]>
>;

export function schedulerWorkerBinding(row: WorkerBindingRow | null) {
  return row
    ? {
        bindingId: row.binding_id,
        workerName: row.worker_name,
        instanceCount: row.instance_count,
        resourceBudget: row.resource_budget
          ? { wallTimeMs: row.resource_budget.wall_time_ms }
          : null,
        tombstone: row.tombstone,
      }
    : null;
}

export function workerWorkerBinding(row: WorkerBindingRow | null) {
  return row
    ? {
        bindingId: row.binding_id,
        name: row.name,
        projectName: row.project_name,
        revision: row.revision,
        workerName: row.worker_name,
        instanceCount: row.instance_count,
        resourceBudget: row.resource_budget
          ? {
              turns: row.resource_budget.turns,
              wallTimeMs: row.resource_budget.wall_time_ms,
            }
          : null,
        entries: row.entries,
        tombstone: row.tombstone,
      }
    : null;
}

export function workerBindingRow(row: WorkerRowView | null) {
  return row
    ? {
        bindingId: row.binding_id,
        projectId: row.project_id,
        resourceIdentity: row.resource_identity,
        tombstone: row.tombstone,
        disabled: row.disabled,
        workerName: row.worker_name,
        entries: row.entries,
        resourceBudget: row.resource_budget
          ? {
              turns: row.resource_budget.turns,
              wallTimeMs: row.resource_budget.wall_time_ms,
            }
          : null,
      }
    : null;
}

export function repositoryPolicyView(policy: RepositoryPolicy | null) {
  return policy
    ? {
        bindingId: policy.binding_id,
        projectId: policy.project_id,
        name: policy.name,
        address: policy.address,
        platform: policy.platform,
        sshCredential: policy.ssh_credential,
        credential: policy.credential,
        baseBranch: policy.base_branch,
        action: policy.action,
        projectPrompt: policy.project_prompt,
        workingLayer: policy.working_layer,
      }
    : null;
}

export function storageBindingView(binding: StorageBinding | null) {
  return binding
    ? {
        bindingId: binding.binding_id,
        projectId: binding.project_id,
        endpoint: binding.endpoint,
        bucket: binding.bucket,
        region: binding.region,
        prefix: binding.prefix,
        credential: binding.credential,
        available: binding.available,
      }
    : null;
}

export function bindingRevisionView(result: BindingRevisionResult | null) {
  return result
    ? {
        projectId: result.project_id,
        bindingId: result.binding_id,
        name: result.name,
        resourceIdentity: result.resource_identity,
        revision: result.revision,
        tombstone: result.tombstone,
        disabled: result.disabled,
      }
    : null;
}

export function bindingIdentityView(
  identity: { binding_id: string; resource_identity: string } | null,
) {
  return identity
    ? {
        bindingId: identity.binding_id,
        resourceIdentity: identity.resource_identity,
      }
    : null;
}
