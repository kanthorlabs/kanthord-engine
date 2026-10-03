import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { CallerContext } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  executionSetupSchema,
  WorkerErrorCode,
  type CredentialMetadataFn,
  type ExecutionSetup,
} from "./contract.ts";
import {
  configuredSource,
  readAgentFile,
  SourceState,
} from "./prompt-source.ts";
import { AgentProviderKind } from "./enablements.ts";
import type { Dependencies, WorkerService } from "./service.ts";

const FIRST = 0;

export async function executionSetup(
  dependencies: Pick<
    Dependencies,
    | "config"
    | "dataDirectory"
    | "workerBindingRowOf"
    | "pinnedCredentialMetadata"
    | "repositoryBindingIdsOf"
    | "repositoryPolicyOf"
  >,
  worker: Pick<WorkerService, "declarationOf" | "workerAgentView">,
  caller: CallerContext,
): Promise<ExecutionSetup> {
  const configured = configuredSource(dependencies.config.globalPrompt);
  const source =
    configured.state === SourceState.Present
      ? await readAgentFile(
          resolve(dependencies.dataDirectory, configured.text),
          { workspace: null, context: caller.context },
        )
      : configured;
  const globalPrompt =
    source.state === SourceState.Absent
      ? { state: SourceState.Absent }
      : source;
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
    const pinned: CredentialMetadataFn = (transaction, name) => {
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
      pinned,
    );
    assert.ok(view);
    if (!view.valid) {
      const issue = view.issues[FIRST];
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
    assert.ok(record);
    const repositories = dependencies
      .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
      .map((id) => {
        const repository = dependencies.repositoryPolicyOf(tx, id);
        assert.ok(repository);
        return {
          bindingId: repository.bindingId,
          name: repository.name,
          address: repository.address,
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
      metadata:
        view.effective.provider === AgentProviderKind.OpenaiCompatible
          ? record.metadata
          : null,
      resourceBudget: row.resourceBudget ?? declaration.resourceBudget,
      repositories,
      globalPrompt,
    });
  });
}
