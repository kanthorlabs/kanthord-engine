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
import { resolveGlobalPrompt } from "../agent/prompt-composer.ts";
import type { Dependencies, WorkerService } from "./service.ts";

const FIRST_ISSUE_INDEX = 0;

export async function executionSetup(
  dependencies: Pick<
    Dependencies,
    | "config"
    | "dataDirectory"
    | "workerBindingRowOf"
    | "pinnedCredentialMetadata"
    | "credentialMetadata"
    | "repositoryBindingIdsOf"
    | "repositoryPolicyOf"
  >,
  worker: Pick<WorkerService, "declarationOf" | "workerAgentView">,
  caller: CallerContext,
): Promise<ExecutionSetup> {
  const globalPrompt = await resolveGlobalPrompt(
    dependencies.config.globalPrompt,
    dependencies.dataDirectory,
    caller.context,
  );
  return caller.commit((tx) => {
    const claim = caller.execution;
    assert.ok(claim);
    const now = Date.now();
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    const declaration = worker.declarationOf(row.workerName);
    assert.ok(declaration);
    const agentName = declaration.agentName;
    if (!agentName)
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
    const configuredEntry = row.entries.find(
      ({ agent }) => agent === agentName,
    );
    const entry = configuredEntry
      ? {
          agentProvider: configuredEntry.agentProvider,
          modelIdentifier: configuredEntry.modelIdentifier,
          reasoningEffort: configuredEntry.reasoningEffort,
        }
      : null;
    const view = worker.workerAgentView(
      tx,
      row.workerName,
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
        { agentName, issues: view.issues },
      );
    }
    assert.ok(view.effective);
    const record = pinned(tx, view.effective.credential);
    const repositories = dependencies
      .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
      .map((id) => {
        const repository = dependencies.repositoryPolicyOf(tx, id);
        assert.ok(repository);
        return {
          bindingId: repository.bindingId,
          name: repository.name,
          address: repository.address,
          sshIdentity: sshIdentitySchema.parse(
            dependencies.credentialMetadata(tx, repository.sshCredential)
              ?.metadata,
          ),
          strategy: { baseBranch: repository.baseBranch },
          projectPrompt: repository.projectPrompt,
        };
      });
    return executionSetupSchema.parse({
      executionId: claim.executionId,
      workerName: row.workerName,
      agentName,
      effectiveConfiguration: view.effective,
      credentialId: record.id,
      metadata: record.metadata,
      resourceBudget: row.resourceBudget ?? declaration.resourceBudget,
      repositories,
      globalPrompt,
    });
  });
}
