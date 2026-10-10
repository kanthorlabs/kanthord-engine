import assert from "node:assert/strict";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { approvedModels } from "../llm/platforms.ts";
import type { ApprovedModelsFn } from "../agent/contract.ts";
import {
  executionSetupSchema,
  sshIdentitySchema,
  WorkerErrorCode,
  type CredentialMetadataRecord,
  type ExecutionSetup,
} from "./contract.ts";
import { PromptConsumer, systemPrompt } from "../agent/prompt-render.ts";
import type { ResolvedLayer } from "../agent/prompt-layers.ts";
import type { Dependencies, WorkerService } from "./service.ts";

const FIRST_ISSUE_INDEX = 0;
const NO_AGENTS = 0;

export async function executionSetup(
  dependencies: Pick<
    Dependencies,
    | "agentPrompt"
    | "store"
    | "workerBindingRowOf"
    | "pinnedCredentialMetadata"
    | "credentialMetadata"
    | "repositoryBindingIdsOf"
    | "repositoryPolicyOf"
  >,
  worker: Pick<WorkerService, "declarationOf" | "workerAgentView">,
  caller: CallerContext,
): Promise<ExecutionSetup> {
  const claim = caller.execution;
  assert.ok(claim);
  const nativeAgentNames = dependencies.store.transaction((tx) => {
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    return worker.declarationOf(row.worker_name)?.agent_names ?? [];
  });
  const layers = new Map<string, ResolvedLayer[]>();
  for (const agentName of nativeAgentNames)
    layers.set(
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
    const agents = agentNames.map((agentName) => {
      const configuredEntry = row.entries.find(
        ({ agent }) => agent === agentName,
      );
      const entry = configuredEntry
        ? {
            agent_provider: configuredEntry.agent_provider,
            model_identifier: configuredEntry.model_identifier,
            reasoning_effort: configuredEntry.reasoning_effort,
          }
        : null;
      const view = worker.workerAgentView(
        tx,
        row.worker_name,
        agentName,
        entry,
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
      const agentLayers = layers.get(agentName);
      assert.ok(agentLayers);
      return {
        agent_name: agentName,
        effective_configuration: view.effective,
        credential_id: record.id,
        metadata: record.metadata,
        prompt: {
          final: systemPrompt(agentLayers, PromptConsumer.Worker, templates),
        },
      };
    });
    const repositories = dependencies
      .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
      .map((id) => {
        const repository = dependencies.repositoryPolicyOf(tx, id);
        assert.ok(repository);
        return {
          binding_id: repository.binding_id,
          name: repository.name,
          address: repository.address,
          ssh_identity: sshIdentitySchema.parse(
            dependencies.credentialMetadata(tx, repository.ssh_credential)
              ?.metadata,
          ),
          strategy: { base_branch: repository.base_branch },
          project_prompt: repository.project_prompt,
          working_layer: repository.working_layer,
        };
      });
    return executionSetupSchema.parse({
      execution_id: claim.executionId,
      worker_name: row.worker_name,
      agents,
      templates,
      resource_budget: row.resource_budget ?? declaration.resource_budget,
      repositories,
    });
  });
}
