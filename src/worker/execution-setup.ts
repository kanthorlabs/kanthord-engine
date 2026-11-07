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
  type AgentSetup,
  type CredentialMetadataRecord,
  type ExecutionEnvironment,
  type ExecutionSetup,
  executionSetupSchema,
  InstancePlacement,
  type SchedulerClaims,
  WorkerErrorCode,
} from "./contract.ts";
import { bindingParts, finalPrompt } from "../agent/prompt-render.ts";
import {
  type PromptPartAnswer,
  PromptPartState,
  PromptSourceReason,
} from "../agent/contract.ts";
import {
  instructionFileRead,
  type InstructionFileTarget,
  pinnedInstructionFiles,
  sourceInvalid,
} from "../agent/instruction-files.ts";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { PROMPT_SOURCE_READ_MS } from "../kernel/prompt-source.ts";
import { bindingText, resolvePrompt } from "../agent/prompt-resolve.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Dependencies, WorkerService } from "./service.ts";
import { RepositoryErrorCode } from "../repository/contract.ts";
import {
  agentPromptFacts,
  type AgentPromptFacts,
  promptReference,
} from "./prompt-telemetry.ts";

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

type SetupDependencies = Pick<
  Dependencies,
  | "agentPrompt"
  | "promptTelemetry"
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
  | "missionPromptPins"
  | "promptBase"
> & {
  schedulerClaims: Pick<SchedulerClaims, "agentSelectionsOf" | "agentPinsOf">;
  clock?: () => number;
};

type SetupPrompt = { final: string; sources: AgentSetup["prompt"]["sources"] };

function promptNotPinned(bindingId: string): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    WorkerErrorCode.ExecutionPromptNotPinned,
    "The attempt holds no instruction commit for the repository binding.",
    { binding_id: bindingId },
  );
}

function promptRecordFailed(agentName: string): OperationError {
  return new OperationError(
    HttpStatus.ServiceUnavailable,
    WorkerErrorCode.ExecutionPromptRecordFailed,
    "The server cannot store the prompt record of the agent.",
    { agent_name: agentName },
  );
}

function instructionTargets(
  dependencies: SetupDependencies,
  tx: Transaction,
  claim: NonNullable<CallerContext["execution"]>,
): InstructionFileTarget[] {
  const named = dependencies
    .repositoryBindingIdsOf(tx, claim.nodeId, claim.pinnedRevision)
    .map((id) => {
      const repository = dependencies.repositoryPolicyOf(tx, id);
      assert.ok(repository);
      return repository;
    })
    .filter(({ prompts }) => prompts.instruction_file !== undefined);
  const pin = dependencies.missionPromptPins.attemptPromptCommits(
    tx,
    claim.nodeId,
    claim.attempt,
  );
  return named.map(({ binding_id, name }) => {
    const entry = pin?.find((item) => item.binding_id === binding_id);
    if (entry === undefined) throw promptNotPinned(binding_id);
    return { binding_id, name, commit: entry.commit };
  });
}

async function storedPrompt(
  dependencies: SetupDependencies,
  facts: AgentPromptFacts,
  reads: Context,
): Promise<SetupPrompt> {
  const { promptBase } = dependencies;
  const resolved = await resolvePrompt(facts.sources, {
    agentName: facts.agent_name,
    bindingTextOf: (bindingId, part, agentName) =>
      bindingText(
        dependencies.store.transaction(
          (tx) => dependencies.repositoryPolicyOf(tx, bindingId)?.prompts,
        ),
        part,
        agentName,
      ),
    instructionFileOf: async (bindingId, commit, path, context) => {
      assert.ok(promptBase);
      return instructionFileRead(
        await promptBase.instructionFileOf(bindingId, commit, context),
        path,
      );
    },
    context: reads,
  });
  const failed = resolved.parts.find(
    ({ state }) => state !== PromptPartState.Resolved,
  );
  if (failed !== undefined || resolved.final === null) {
    assert.ok(failed);
    throw sourceInvalid({
      part: failed.part,
      name: failed.name,
      binding_id: failed.binding_id,
      path: failed.path,
      commit: failed.commit,
      reason: PromptSourceReason.Changed,
    });
  }
  return { final: resolved.final, sources: [...facts.sources] };
}

function recordedPrompt(
  dependencies: SetupDependencies,
  executionId: string,
  facts: AgentPromptFacts,
): AgentPromptFacts {
  try {
    dependencies.promptTelemetry.agentPrompted(executionId, facts);
  } catch {
    throw promptRecordFailed(facts.agent_name);
  }
  const stored = dependencies.promptTelemetry.promptRecordOf(
    executionId,
    facts.agent_name,
  );
  if (stored === null) throw promptRecordFailed(facts.agent_name);
  return stored;
}

type SetupWorker = Pick<
  WorkerService,
  "declarationOf" | "pinnedAgentView" | "placementOf"
>;

export async function executionSetup(
  dependencies: SetupDependencies,
  worker: SetupWorker,
  caller: CallerContext,
): Promise<ExecutionSetup> {
  const reads = new CancellationContext(
    caller.context,
    (dependencies.clock ?? Date.now)() + PROMPT_SOURCE_READ_MS,
  );
  try {
    return await setupWithin(dependencies, worker, caller, reads);
  } finally {
    reads.cancel();
  }
}

async function setupWithin(
  dependencies: SetupDependencies,
  worker: SetupWorker,
  caller: CallerContext,
  reads: Context,
): Promise<ExecutionSetup> {
  const claim = caller.execution;
  assert.ok(claim);
  const { nativeAgentNames, targets } = dependencies.store.transaction((tx) => {
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    const names = worker.declarationOf(row.worker_name)?.agent_names ?? [];
    return {
      nativeAgentNames: names,
      targets:
        names.length === NO_AGENTS
          ? []
          : instructionTargets(dependencies, tx, claim),
    };
  });
  const answered = new Map<string, SetupPrompt>();
  const parts = new Map<string, PromptPartAnswer[]>();
  for (const agentName of nativeAgentNames) {
    const record = dependencies.promptTelemetry.promptRecordOf(
      claim.executionId,
      agentName,
    );
    if (record === null)
      parts.set(
        agentName,
        await dependencies.agentPrompt.compose(agentName, caller.context),
      );
    else
      answered.set(agentName, await storedPrompt(dependencies, record, reads));
  }
  const composes = parts.size > NO_AGENTS;
  const files =
    composes && targets.length > NO_AGENTS
      ? await pinnedInstructionFiles(
          targets,
          (bindingId, commit, context) => {
            assert.ok(dependencies.promptBase);
            return dependencies.promptBase.instructionFileOf(
              bindingId,
              commit,
              context,
            );
          },
          reads,
        )
      : new Map();
  const framing = composes
    ? await dependencies.agentPrompt.framing(caller.context)
    : null;
  const templates = await dependencies.agentPrompt.templates(caller.context);
  const prompted: AgentPromptFacts[] = [];
  const setup = caller.commit((tx) => {
    const now = Date.now();
    const row = dependencies.workerBindingRowOf(tx, claim.workerBindingId);
    assert.ok(row);
    const declaration = worker.declarationOf(row.worker_name);
    assert.ok(declaration);
    const placement = worker.placementOf(tx, claim.runtimeIdentity);
    const agentNames = declaration.agent_names ?? [];
    const selections = dependencies.schedulerClaims.agentSelectionsOf(
      tx,
      claim.executionId,
    );
    const agentPins = dependencies.schedulerClaims.agentPinsOf(
      tx,
      claim.executionId,
    );
    assert.ok(agentPins, "A claimed execution must hold a row.");
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
    const composedPrompt = (agentName: string): SetupPrompt => {
      const agentParts = parts.get(agentName);
      assert.ok(agentParts);
      assert.ok(framing);
      const promptParts = [
        ...agentParts,
        ...bindingParts(policies, agentName, files),
        framing,
      ];
      const final = finalPrompt(promptParts);
      assert.ok(final !== null);
      prompted.push(agentPromptFacts(agentName, promptParts, templates));
      return { final, sources: promptParts.map(promptReference) };
    };
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
      const prompt = answered.get(agentName) ?? composedPrompt(agentName);
      return {
        agent_name: agentName,
        enablement_id:
          agentPins.pins.find(({ agent_name }) => agent_name === agentName)
            ?.enablement_id ?? null,
        worker_binding_id: agentPins.worker_binding_id,
        effective_configuration: view.effective,
        position: selection.position,
        level: selection.level,
        credential_id: record.id,
        metadata: record.metadata,
        prompt,
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
        placement,
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
    if (placement === InstancePlacement.Container && row.environment)
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
  const recorded = new Map<string, SetupPrompt>();
  for (const facts of prompted) {
    const stored = recordedPrompt(dependencies, claim.executionId, facts);
    if (canonicalJSON(stored.sources) !== canonicalJSON(facts.sources))
      recorded.set(
        facts.agent_name,
        await storedPrompt(dependencies, stored, reads),
      );
  }
  return recorded.size === NO_AGENTS
    ? setup
    : {
        ...setup,
        agents: setup.agents.map((agent) => ({
          ...agent,
          prompt: recorded.get(agent.agent_name) ?? agent.prompt,
        })),
      };
}
