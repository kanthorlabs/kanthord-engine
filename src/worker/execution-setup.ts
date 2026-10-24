import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { approvedModels } from "../llm/platforms.ts";
import type { ApprovedModelsFn } from "../agent/contract.ts";
import type { Environment } from "../kernel/devcontainer.ts";
import { EnvironmentSource } from "../kernel/devcontainer.ts";
import {
  executionSetupSchema,
  InstancePlacement,
  WorkerErrorCode,
  type ExecutionEnvironment,
  type CredentialMetadataRecord,
  type ExecutionSetup,
  type SchedulerClaims,
} from "./contract.ts";
import {
  bindingParts,
  PromptConsumer,
  systemPrompt,
} from "../agent/prompt-render.ts";
import type { PromptPartAnswer } from "../agent/contract.ts";
import type { Dependencies, WorkerService } from "./service.ts";
import { RepositoryErrorCode } from "../repository/contract.ts";

const FIRST_ISSUE_INDEX = 0;

type RecordedEnvironment = ReturnType<Dependencies["environmentOf"]> & object;

function executionEnvironment(
  stored: Environment | null,
  repositoryEnvironment: boolean,
  placement: InstancePlacement | null,
  digest: string | null,
  recorded: RecordedEnvironment | null,
): ExecutionEnvironment {
  if (stored !== null) {
    assert.ok(digest, "A claimed environment must hold a computed digest.");
    return { source: EnvironmentSource.Stored, document: stored, digest };
  }
  if (placement !== InstancePlacement.Container) return null;
  if (
    recorded?.source === EnvironmentSource.Detected ||
    recorded?.source === EnvironmentSource.Universal
  )
    return { source: recorded.source, document: recorded.document };
  if (!repositoryEnvironment) return null;
  assert.ok(digest, "A claimed environment must hold a computed digest.");
  return { source: EnvironmentSource.Repository, digest };
}

const NO_AGENTS = 0;

export async function executionSetup(
  dependencies: Pick<
    Dependencies,
    | "agentPrompt"
    | "store"
    | "workerBindingRowOf"
    | "pinnedCredentialMetadata"
    | "sshHostKeysOf"
    | "repositoryBindingIdsOf"
    | "intentOf"
    | "repositoryPolicyOf"
    | "custodyHandover"
    | "environmentClaimed"
    | "environmentDigestOf"
    | "environmentOf"
  > & { schedulerClaims: Pick<SchedulerClaims, "agentSelectionsOf"> },
  worker: Pick<WorkerService, "declarationOf" | "pinnedAgentView">,
  caller: CallerContext,
): Promise<ExecutionSetup> {
  const claim = caller.execution;
  assert.ok(claim);
  const nativeAgentNames = dependencies.store.transaction((tx) => {
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    return worker.declarationOf(row.worker_name)?.agent_names ?? [];
  });
  const parts = new Map<string, PromptPartAnswer[]>();
  for (const agentName of nativeAgentNames)
    parts.set(
      agentName,
      await dependencies.agentPrompt.compose(agentName, caller.context),
    );
  const templates = await dependencies.agentPrompt.templates(caller.context);
  return caller.commit((tx) => {
    const now = Date.now();
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    const declaration = worker.declarationOf(row.worker_name);
    assert.ok(declaration);
    const agentNames = declaration.agent_names ?? [];
    const selections = dependencies.schedulerClaims.agentSelectionsOf(
      tx,
      claim.executionId,
    );
    if (agentNames.length === NO_AGENTS)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.ExecutionNoNativeAgent,
        "Execution has no native agent.",
      );
    const pinned = (
      transaction: Transaction,
      name: string,
    ): CredentialMetadataRecord => {
      const record = dependencies.pinnedCredentialMetadata(
        transaction,
        claim,
        name,
        now,
      );
      if (!record)
        throw new OperationError(
          HttpStatus.Conflict,
          WorkerErrorCode.ExecutionCredentialNotPinned,
          "Execution has no pinned revision of the credential.",
          { credential: name },
        );
      return record;
    };
    const pinnedModels: ApprovedModelsFn = (transaction, name) => {
      const record = pinned(transaction, name);
      return approvedModels(record.platform, record.metadata);
    };
    const policies = dependencies
      .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
      .map((id) => {
        const repository = dependencies.repositoryPolicyOf(tx, id);
        assert.ok(repository);
        return repository;
      });
    const agents = agentNames.map((agentName) => {
      const selection = selections.find(
        ({ agent_name }) => agent_name === agentName,
      );
      assert.ok(
        selection,
        "A native agent of a claimed execution must hold a pin.",
      );
      const view = worker.pinnedAgentView(
        tx,
        row.worker_name,
        selection,
        pinnedModels,
      );
      assert.ok(view);
      if (!view.valid) {
        const issue = view.issues[FIRST_ISSUE_INDEX];
        assert.ok(issue);
        throw new OperationError(
          HttpStatus.BadRequest,
          issue.code,
          "Agent configuration is unavailable or invalid.",
          { agent_name: agentName, issues: view.issues },
        );
      }
      assert.ok(view.effective);
      const record = pinned(tx, view.effective.credential);
      const agentParts = parts.get(agentName);
      assert.ok(agentParts);
      return {
        agent_name: agentName,
        effective_configuration: view.effective,
        position: selection.position,
        level: selection.level,
        credential_id: record.id,
        metadata: record.metadata,
        prompt: {
          final: systemPrompt(
            [...agentParts, ...bindingParts(policies, agentName)],
            PromptConsumer.Worker,
            templates,
          ),
        },
      };
    });
    const sshPublicKeyOf = (credential: string): string => {
      const publicKey = dependencies.custodyHandover.sshPublicKeyOf(
        tx,
        claim,
        credential,
        now,
      );
      if (publicKey === null)
        throw new OperationError(
          HttpStatus.Conflict,
          RepositoryErrorCode.SshKeyLegacy,
          "The SSH credential holds no generated key. Use Rotate SSH key.",
          { credential },
        );
      return publicKey;
    };
    const repositories = policies.map((repository) => ({
      binding_id: repository.binding_id,
      resource_identity: repository.resource_identity,
      name: repository.name,
      address: repository.address,
      ssh_host_key: {
        known_hosts: dependencies.sshHostKeysOf(
          tx,
          repository.platform,
          repository.address,
        ),
      },
      ssh_public_key: sshPublicKeyOf(repository.ssh_credential),
      strategy: { base_branch: repository.base_branch },
      environment: executionEnvironment(
        repository.environment,
        repository.repository_environment,
        row.placement,
        dependencies.environmentDigestOf(
          claim.projectId,
          repository.resource_identity,
        ),
        dependencies.environmentOf(
          claim.projectId,
          repository.resource_identity,
        ),
      ),
    }));
    if (row.placement === InstancePlacement.Container && row.environment)
      dependencies.environmentClaimed(claim.projectId, row.environment);
    return executionSetupSchema.parse({
      execution_id: claim.executionId,
      worker_name: row.worker_name,
      agents,
      templates,
      resource_budget: row.resource_budget ?? declaration.resource_budget,
      intent: dependencies.intentOf(tx, claim.nodeId, claim.pinnedRevision),
      repositories,
    });
  });
}
