import assert from "node:assert/strict";
import type { Environment } from "../kernel/devcontainer.ts";
import { EnvironmentSource } from "../project/contract.ts";
import {
  setTimeout as delay,
  setImmediate as turn,
} from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { Store } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { executionSetup } from "./execution-setup.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AgentErrorCode,
  ChainLevel,
  type InstructionFileReader,
  InstructionFileState,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  PromptSourceReason,
} from "../agent/contract.ts";
import type { PromptCommits } from "./contract.ts";
import { packageVersion } from "../kernel/version.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import { resolveAgentPrompt } from "../agent/prompt-files.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import {
  framing,
  PromptConsumer,
  promptPart,
  systemPrompt,
} from "../agent/prompt-render.ts";
import {
  anthropicSetup,
  memoryPromptTelemetry,
  shippedFraming,
  TEST_SSH_PUBLIC_KEY,
  TWO_AGENT_WORKER,
  twoAgentDeclarationOf,
} from "./test-support.ts";
import { WorkerErrorCode } from "./contract.ts";
import { digest } from "../agent/prompt-composer.ts";
import type { Dependencies } from "./service.ts";
import { type AgentPromptFacts, promptReference } from "./prompt-telemetry.ts";
import { PROMPT_SOURCE_READ_MS } from "../kernel/prompt-source.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { ExecutionIntent, InstancePlacement } from "./contract.ts";
import type { AgentSelection } from "../scheduler/contract.ts";
import {
  RepositoryComponent,
  repositoryMigrations,
} from "../repository/index.ts";
import {
  HostKeyErrorCode,
  RepositoryErrorCode,
} from "../repository/contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  InstructionFileReason,
  ProjectErrorCode,
  RepositoryPlatform,
} from "../project/contract.ts";
import {
  Onboarding,
  type OnboardingDependencies,
} from "../project/onboarding.ts";

const SSH_CREDENTIAL = "kanthorlabs-ssh";
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const NO_REQUESTS = 0;
const ONE_READ = 1;
const REPOSITORY_IDENTITY = "repository:github:kanthorlabs/api";
const API_IDENTITY = "repository:github:kanthorlabs/api";
const ENVIRONMENT_DIGEST = "e".repeat(64);
const publicKeyCustody = {
  handover: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  report: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  lease: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  sshSign: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
  sshPublicKeyOf: (_tx: unknown, _claim: unknown, name: string) => {
    assert.equal(name, SSH_CREDENTIAL);
    return TEST_SSH_PUBLIC_KEY;
  },
};
const STANDARD_TEXT = "standard part text";
const AGENT_TEXT = "agent part text";
const SWE_BINDING_TEXT = "Run pnpm verify before the end of a turn.";
const OVERRIDE_TEXT = "Write the smallest complete change.";
const INVALID_OVERRIDE_TEXT = "bell\u0007";
const SECOND_SWE_TEXT = "Keep the web bundle small.";
const RE_BINDING_TEXT = "Treat a missing changelog entry as a blocker.";
const REPOSITORY_TEXT = "A test file sits beside its source file.";

function partOf(
  part: PromptPart,
  name: string,
  text: string,
): PromptPartAnswer {
  return promptPart(
    {
      part,
      name,
      origin: PromptOrigin.File,
      path: null,
      binding_id: null,
      commit: null,
      digest: "0".repeat(64),
    },
    PromptPartState.Resolved,
    text,
  );
}

const NO_PROMPT_PINS = {
  attemptPromptCommits: () => null,
  pinPromptCommits: () => {
    throw new Error("UNEXPECTED_COLLABORATION");
  },
};

const promptParts = [
  partOf(PromptPart.Standard, "base.md", STANDARD_TEXT),
  partOf(PromptPart.Role, "swe@1.md", AGENT_TEXT),
];

test("setup answers the system and agent prompt after its single snapshot and supports a pinned entry", async (t) => {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  const setup = anthropicSetup();
  const agent = setup.agents[0]!;
  const entry = {
    agent: agent.agent_name,
    agent_provider: "default",
    model_identifier: agent.effective_configuration.model_identifier,
    reasoning_effort: "low",
  };
  const selection: AgentSelection = {
    agent_name: agent.agent_name,
    position: 1,
    level: ChainLevel.Binding,
    agent_provider: entry.agent_provider,
    provider: agent.effective_configuration.provider,
    credential: "pinned-key",
    model_identifier: entry.model_identifier,
    reasoning_effort: entry.reasoning_effort,
  };
  const enablementId = createIdentity("agent_enablement");
  const composed: string[] = [];
  const requested: string[] = [];
  let commits = 0;
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: createIdentity("project"),
  };
  const caller: CallerContext = {
    identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
    context: background,
    requestId: "request",
    execution: claim,
    commit: (fn) => {
      commits++;
      return store.transaction(fn);
    },
  };
  const claimed: string[][] = [];
  const digested: string[][] = [];
  const dependencies = {
    store,
    promptTelemetry: memoryPromptTelemetry(),
    missionPromptPins: NO_PROMPT_PINS,
    agentPrompt: {
      templates: async () => SHIPPED_TEMPLATES,
      framing: async () => shippedFraming(),
      compose: async (agentName: string) => {
        composed.push(agentName);
        return promptParts;
      },
    },
    workerBindingRowOf: () => ({
      binding_id: claim.workerBindingId,
      project_id: claim.projectId,
      resource_identity: "worker:coder@1",
      tombstone: false,
      disabled: false,
      placement: InstancePlacement.Server,
      worker_instances: [],
      worker_name: setup.worker_name,
      entries: [entry],
      resource_budget: null,
    }),
    pinnedCredentialMetadata: (_tx: unknown, _claim: unknown, name: string) => {
      requested.push(name);
      return {
        id:
          name === selection.credential
            ? agent.credential_id
            : createIdentity("credential"),
        name,
        platform: agent.effective_configuration.provider,
        metadata: null,
      };
    },
    environmentClaimed: (projectId: string, resourceIdentity: string) => {
      claimed.push([projectId, resourceIdentity]);
    },
    environmentDigestOf: (projectId: string, resourceIdentity: string) => {
      digested.push([projectId, resourceIdentity]);
      return ENVIRONMENT_DIGEST;
    },
    environmentOf: () => null,
    repositoryBindingIdsOf: () => [],
    intentOf: () => ExecutionIntent.Implement,
    repositoryPolicyOf: () => null,
    sshHostKeysOf: () => {
      throw new Error("UNEXPECTED_COLLABORATION");
    },
    custodyHandover: publicKeyCustody,
    schedulerClaims: {
      agentSelectionsOf: () => [selection],
      agentPinsOf: () => ({
        worker_binding_id: claim.workerBindingId,
        pins: [
          {
            agent_name: agent.agent_name,
            enablement_id: enablementId,
            position: selection.position,
          },
        ],
      }),
    },
  };
  const worker = {
    declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
    placementOf: () => InstancePlacement.Server,
    pinnedAgentView: (
      ...args: Parameters<
        import("./service.ts").WorkerService["pinnedAgentView"]
      >
    ) => {
      assert.deepEqual(args[2], selection);
      assert.ok(args[3]);
      args[3](args[0], selection.credential);
      return {
        effective: {
          ...agent.effective_configuration,
          credential: selection.credential,
          reasoning_effort: selection.reasoning_effort,
        },
        valid: true,
        issues: [],
      };
    },
  };
  const before = commits;
  const answer = await executionSetup(dependencies, worker, caller);
  assert.deepEqual(composed, [agent.agent_name]);
  const [answered] = answer.agents;
  assert.ok(answered);
  assert.deepEqual(answered.prompt, {
    final: systemPrompt(promptParts, PromptConsumer.Worker, SHIPPED_TEMPLATES),
    sources: [...promptParts, shippedFraming()].map(promptReference),
  });
  assert.ok(
    answered.prompt.final.endsWith(
      framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
    ),
  );
  assert.ok(answered.prompt.final.includes(STANDARD_TEXT));
  assert.ok(answered.prompt.final.includes(AGENT_TEXT));
  assert.equal(
    answered.effective_configuration.reasoning_effort,
    entry.reasoning_effort,
  );
  assert.equal(
    answered.effective_configuration.credential,
    selection.credential,
  );
  assert.equal(answered.credential_id, agent.credential_id);
  assert.deepEqual(new Set(requested), new Set([selection.credential]));
  assert.ok(requested.length > NO_REQUESTS);
  assert.equal(answered.position, selection.position);
  assert.equal(answered.level, selection.level);
  assert.equal(answered.enablement_id, enablementId);
  assert.equal(answered.worker_binding_id, claim.workerBindingId);
  assert.equal(commits, before + 1);
  await assert.rejects(
    executionSetup(
      dependencies,
      {
        ...worker,
        declarationOf: () => getWorkerDeclaration("claude-code@1")!,
      },
      caller,
    ),
    (error) =>
      error instanceof OperationError &&
      error.code === WorkerErrorCode.ExecutionNoNativeAgent,
  );
  const promptDirectory = temporary(t);
  const overridePath = join(promptDirectory, `${agent.agent_name}.md`);
  writeFileSync(overridePath, OVERRIDE_TEXT);
  const resolving = {
    ...dependencies,
    promptTelemetry: memoryPromptTelemetry(),
    missionPromptPins: NO_PROMPT_PINS,
    agentPrompt: {
      templates: async () => SHIPPED_TEMPLATES,
      framing: async () => shippedFraming(),
      compose: (agentName: string) =>
        resolveAgentPrompt({
          agent: getAgentDeclaration(agentName)!,
          directory: promptDirectory,
          workbench: false,
          context: background,
        }),
    },
  };
  const overridden = await executionSetup(resolving, worker, caller);
  assert.ok(overridden.agents[0]!.prompt.final.includes(OVERRIDE_TEXT));
  assert.ok(
    !overridden.agents[0]!.prompt.final.includes(
      getAgentDeclaration(agent.agent_name)!.agent_prompt,
    ),
  );
  writeFileSync(overridePath, INVALID_OVERRIDE_TEXT);
  const fresh = { ...resolving, promptTelemetry: memoryPromptTelemetry() };
  await assert.rejects(executionSetup(fresh, worker, caller), {
    status: HttpStatus.Conflict,
    code: AgentErrorCode.PromptTemplateInvalid,
    details: {
      file: `${agent.agent_name}.md`,
      path: overridePath,
      reason: "control_character",
    },
  });
  const bindingId = createIdentity("binding");
  const address = "git@github.com:kanthorlabs/kanthord.git";
  const knownHosts = `github.com ${HOST_KEY}\n`;
  const pinned = await executionSetup(
    {
      ...dependencies,
      promptTelemetry: memoryPromptTelemetry(),
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        resource_identity: REPOSITORY_IDENTITY,
        name: "repo",
        address,
        platform: RepositoryPlatform.GitHub,
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        prompts: {},
        environment: null,
        repository_environment: true,
      }),
      sshHostKeysOf: (_tx, platform, received) => {
        assert.equal(platform, RepositoryPlatform.GitHub);
        assert.equal(received, address);
        return knownHosts;
      },
    },
    worker,
    caller,
  );
  assert.deepEqual(pinned.repositories[0]?.ssh_host_key, {
    known_hosts: knownHosts,
  });
  assert.equal(pinned.repositories[0]?.ssh_public_key, TEST_SSH_PUBLIC_KEY);
  assert.equal(pinned.repositories[0]?.resource_identity, REPOSITORY_IDENTITY);
  await assert.rejects(
    executionSetup(
      {
        ...dependencies,
        promptTelemetry: memoryPromptTelemetry(),
        repositoryBindingIdsOf: () => [bindingId],
        repositoryPolicyOf: () => ({
          binding_id: bindingId,
          resource_identity: REPOSITORY_IDENTITY,
          name: "repo",
          address,
          platform: RepositoryPlatform.GitHub,
          ssh_credential: SSH_CREDENTIAL,
          base_branch: "main",
          prompts: {},
          environment: null,
          repository_environment: true,
        }),
        sshHostKeysOf: () => knownHosts,
        custodyHandover: { ...publicKeyCustody, sshPublicKeyOf: () => null },
      },
      worker,
      caller,
    ),
    (error) =>
      error instanceof OperationError &&
      error.code === RepositoryErrorCode.SshKeyLegacy &&
      error.status === HttpStatus.Conflict,
  );
  const stored = { image: "debian", postCreateCommand: "make deps" };
  const environmentOf = async (
    environment: typeof stored | null,
    placement: InstancePlacement,
    repositoryEnvironment = true,
    recorded: {
      source: EnvironmentSource;
      document: Environment;
    } | null = null,
  ) =>
    (
      await executionSetup(
        {
          ...dependencies,
          promptTelemetry: memoryPromptTelemetry(),
          environmentOf: () => recorded,
          repositoryBindingIdsOf: () => [bindingId],
          repositoryPolicyOf: () => ({
            binding_id: bindingId,
            resource_identity: REPOSITORY_IDENTITY,
            name: "repo",
            address,
            platform: RepositoryPlatform.GitHub,
            ssh_credential: SSH_CREDENTIAL,
            base_branch: "main",
            prompts: {},
            environment,
            repository_environment: repositoryEnvironment,
          }),
          sshHostKeysOf: () => knownHosts,
        },
        { ...worker, placementOf: () => placement },
        caller,
      )
    ).repositories[0]?.environment;
  for (const placement of Object.values(InstancePlacement))
    assert.deepEqual(await environmentOf(stored, placement), {
      source: EnvironmentSource.Stored,
      document: stored,
      digest: ENVIRONMENT_DIGEST,
    });
  assert.deepEqual(await environmentOf(null, InstancePlacement.Container), {
    source: EnvironmentSource.Repository,
    digest: ENVIRONMENT_DIGEST,
  });
  assert.ok(digested.length > NO_REQUESTS);
  for (const call of digested)
    assert.deepEqual(call, [claim.projectId, REPOSITORY_IDENTITY]);
  assert.equal(
    await environmentOf(null, InstancePlacement.Container, false),
    null,
  );
  assert.equal(await environmentOf(null, InstancePlacement.Server), null);
  assert.equal(await environmentOf(null, InstancePlacement.Worker), null);
  const detected = { image: "debian", updateContentCommand: "npm ci" };
  for (const source of [
    EnvironmentSource.Detected,
    EnvironmentSource.Universal,
  ])
    assert.deepEqual(
      await environmentOf(null, InstancePlacement.Container, true, {
        source,
        document: detected,
      }),
      { source, document: detected },
    );
  for (const placement of [InstancePlacement.Server, InstancePlacement.Worker])
    assert.equal(
      await environmentOf(null, placement, true, {
        source: EnvironmentSource.Detected,
        document: detected,
      }),
      null,
    );
  const claimedBy = async (placement: InstancePlacement) => {
    claimed.length = NO_REQUESTS;
    await executionSetup(
      {
        ...dependencies,
        promptTelemetry: memoryPromptTelemetry(),
        workerBindingRowOf: () => ({
          ...dependencies.workerBindingRowOf(),
          environment: API_IDENTITY,
        }),
        repositoryBindingIdsOf: () => [bindingId],
        repositoryPolicyOf: () => ({
          binding_id: bindingId,
          resource_identity: API_IDENTITY,
          name: "api",
          address,
          platform: RepositoryPlatform.GitHub,
          ssh_credential: SSH_CREDENTIAL,
          base_branch: "main",
          prompts: {},
          environment: null,
          repository_environment: true,
        }),
        sshHostKeysOf: () => knownHosts,
      },
      { ...worker, placementOf: () => placement },
      caller,
    );
    return [...claimed];
  };
  assert.deepEqual(await claimedBy(InstancePlacement.Container), [
    [claim.projectId, API_IDENTITY],
  ]);
  assert.deepEqual(await claimedBy(InstancePlacement.Server), []);
  assert.deepEqual(await claimedBy(InstancePlacement.Worker), []);
});

test("setup claims no environment for a container slot whose worker binding names none", async (t) => {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  const setup = anthropicSetup();
  const agent = setup.agents[0]!;
  const claimed: string[][] = [];
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: createIdentity("project"),
  };
  await executionSetup(
    {
      store,
      promptTelemetry: memoryPromptTelemetry(),
      missionPromptPins: NO_PROMPT_PINS,
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
        framing: async () => shippedFraming(),
        compose: async () => promptParts,
      },
      workerBindingRowOf: () => ({
        binding_id: claim.workerBindingId,
        project_id: claim.projectId,
        resource_identity: "worker:coder@1",
        tombstone: false,
        disabled: false,
        placement: InstancePlacement.Container,
        worker_instances: [],
        environment: null,
        worker_name: setup.worker_name,
        entries: [],
        resource_budget: null,
      }),
      pinnedCredentialMetadata: (_tx, _claim, name) => ({
        id: agent.credential_id,
        name,
        platform: agent.effective_configuration.provider,
        metadata: null,
      }),
      environmentClaimed: (projectId, resourceIdentity) => {
        claimed.push([projectId, resourceIdentity]);
      },
      environmentDigestOf: () => ENVIRONMENT_DIGEST,
      environmentOf: () => null,
      repositoryBindingIdsOf: () => [],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => null,
      sshHostKeysOf: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      custodyHandover: publicKeyCustody,
      schedulerClaims: {
        agentSelectionsOf: () => [
          {
            agent_name: agent.agent_name,
            position: 0,
            level: ChainLevel.Enablement,
            agent_provider: "default",
            provider: agent.effective_configuration.provider,
            credential: "key",
            model_identifier: agent.effective_configuration.model_identifier,
            reasoning_effort: "low",
          },
        ],
        agentPinsOf: () => ({
          worker_binding_id: claim.workerBindingId,
          pins: [],
        }),
      },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
      placementOf: () => InstancePlacement.Container,
      pinnedAgentView: () => ({
        effective: agent.effective_configuration,
        valid: true,
        issues: [],
      }),
    },
    {
      identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
      context: background,
      requestId: "request",
      execution: claim,
      commit: (fn) => store.transaction(fn),
    },
  );
  assert.deepEqual(claimed, []);
});

test("one binding that lists a server and a container instance claims the environment for the container instance only", async (t) => {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  const setup = anthropicSetup();
  const agent = setup.agents[0]!;
  const claimed: string[][] = [];
  const coderRuntime = createIdentity("worker_registration");
  const builderRuntime = createIdentity("worker_registration");
  const placements = new Map([
    [coderRuntime, InstancePlacement.Server],
    [builderRuntime, InstancePlacement.Container],
  ]);
  const claimOf = (runtimeIdentity: string) => ({
    executionId: setup.execution_id,
    runtimeIdentity,
    workerBindingId: "binding",
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: "project",
  });
  const claimedBy = async (runtimeIdentity: string) => {
    claimed.length = NO_REQUESTS;
    const claim = claimOf(runtimeIdentity);
    await executionSetup(
      {
        store,
        promptTelemetry: memoryPromptTelemetry(),
        missionPromptPins: NO_PROMPT_PINS,
        agentPrompt: {
          templates: async () => SHIPPED_TEMPLATES,
          framing: async () => shippedFraming(),
          compose: async () => promptParts,
        },
        workerBindingRowOf: () => ({
          binding_id: claim.workerBindingId,
          project_id: claim.projectId,
          resource_identity: "worker:coder@1",
          tombstone: false,
          disabled: false,
          placement: null,
          worker_instances: ["coder-1", "builder-1"],
          environment: API_IDENTITY,
          worker_name: setup.worker_name,
          entries: [],
          resource_budget: null,
        }),
        pinnedCredentialMetadata: (_tx, _claim, name) => ({
          id: agent.credential_id,
          name,
          platform: agent.effective_configuration.provider,
          metadata: null,
        }),
        environmentClaimed: (projectId, resourceIdentity) => {
          claimed.push([projectId, resourceIdentity]);
        },
        environmentDigestOf: () => ENVIRONMENT_DIGEST,
        environmentOf: () => null,
        repositoryBindingIdsOf: () => [],
        intentOf: () => ExecutionIntent.Implement,
        repositoryPolicyOf: () => null,
        sshHostKeysOf: () => {
          throw new Error("UNEXPECTED_COLLABORATION");
        },
        custodyHandover: publicKeyCustody,
        schedulerClaims: {
          agentSelectionsOf: () => [
            {
              agent_name: agent.agent_name,
              position: 0,
              level: ChainLevel.Enablement,
              agent_provider: "default",
              provider: agent.effective_configuration.provider,
              credential: "key",
              model_identifier: agent.effective_configuration.model_identifier,
              reasoning_effort: "low",
            },
          ],
          agentPinsOf: () => ({
            worker_binding_id: claim.workerBindingId,
            pins: [],
          }),
        },
      },
      {
        declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
        placementOf: (_tx, identity) => placements.get(identity) ?? null,
        pinnedAgentView: () => ({
          effective: agent.effective_configuration,
          valid: true,
          issues: [],
        }),
      },
      {
        identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
        context: background,
        requestId: "request",
        execution: claim,
        commit: (fn) => store.transaction(fn),
      },
    );
    return [...claimed];
  };
  assert.deepEqual(await claimedBy(builderRuntime), [
    ["project", API_IDENTITY],
  ]);
  assert.deepEqual(await claimedBy(coderRuntime), []);
});

test("setup of a container worker binding with an environment claims inside a real transaction and its compute reads the binding facts", async (t) => {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  const setup = anthropicSetup();
  const agent = setup.agents[0]!;
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: createIdentity("project"),
  };
  const failures: unknown[] = [];
  let reads = 0;
  const onboarding = new Onboarding({
    bindingsOf: () => {
      reads++;
      return store.transaction(() => ({ repositories: [], workers: [] }));
    },
    logger: { error: (failure: unknown) => failures.push(failure) },
  } as unknown as OnboardingDependencies);
  stopAfter(t, () => onboarding.stop());
  const bindingId = createIdentity("binding");
  const answer = await executionSetup(
    {
      store,
      promptTelemetry: memoryPromptTelemetry(),
      missionPromptPins: NO_PROMPT_PINS,
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
        framing: async () => shippedFraming(),
        compose: async () => promptParts,
      },
      workerBindingRowOf: () => ({
        binding_id: claim.workerBindingId,
        project_id: claim.projectId,
        resource_identity: "worker:coder@1",
        tombstone: false,
        disabled: false,
        placement: InstancePlacement.Container,
        worker_instances: [],
        environment: API_IDENTITY,
        worker_name: setup.worker_name,
        entries: [],
        resource_budget: null,
      }),
      pinnedCredentialMetadata: (_tx, _claim, name) => ({
        id: agent.credential_id,
        name,
        platform: agent.effective_configuration.provider,
        metadata: null,
      }),
      environmentClaimed: (projectId, resourceIdentity) =>
        onboarding.environmentClaimed(projectId, resourceIdentity),
      environmentDigestOf: () => ENVIRONMENT_DIGEST,
      environmentOf: () => null,
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        resource_identity: API_IDENTITY,
        name: "api",
        address: "git@github.com:kanthorlabs/kanthord.git",
        platform: RepositoryPlatform.GitHub,
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        prompts: {},
        environment: null,
        repository_environment: true,
      }),
      sshHostKeysOf: () => `github.com ${HOST_KEY}\n`,
      custodyHandover: publicKeyCustody,
      schedulerClaims: {
        agentSelectionsOf: () => [
          {
            agent_name: agent.agent_name,
            position: 0,
            level: ChainLevel.Enablement,
            agent_provider: "default",
            provider: agent.effective_configuration.provider,
            credential: "key",
            model_identifier: agent.effective_configuration.model_identifier,
            reasoning_effort: "low",
          },
        ],
        agentPinsOf: () => ({
          worker_binding_id: claim.workerBindingId,
          pins: [],
        }),
      },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
      placementOf: () => InstancePlacement.Container,
      pinnedAgentView: () => ({
        effective: agent.effective_configuration,
        valid: true,
        issues: [],
      }),
    },
    {
      identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
      context: background,
      requestId: "request",
      execution: claim,
      commit: (fn) => store.transaction(fn),
    },
  );
  assert.deepEqual(answer.repositories[0]?.environment, {
    source: EnvironmentSource.Repository,
    digest: ENVIRONMENT_DIGEST,
  });
  assert.equal(reads, NO_REQUESTS);
  await turn();
  assert.equal(reads, ONE_READ);
  assert.deepEqual(failures, []);
});

interface TwoAgentOptions {
  promptTelemetry?: Dependencies["promptTelemetry"];
  instructionFile?: string;
  pins?: (attempt: number) => PromptCommits | null;
  readFile?: InstructionFileReader;
  compose?: (agentName: string) => PromptPartAnswer[];
  everyBindingNamesFile?: boolean;
  composeDelayMs?: number;
  clock?: () => number;
}

async function twoAgentAnswer(
  t: TestContext,
  promptTelemetry: Dependencies["promptTelemetry"],
) {
  const f = twoAgentFixture(t, { promptTelemetry });
  return { ...f, answer: await f.run() };
}

function twoAgentFixture(t: TestContext, options: TwoAgentOptions = {}) {
  const promptTelemetry = options.promptTelemetry ?? memoryPromptTelemetry();
  const composed: string[] = [];
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  const setup = anthropicSetup();
  const enablementIds: Record<string, string> = {
    "swe@1": createIdentity("agent_enablement"),
    "re@1": createIdentity("agent_enablement"),
  };
  const credentials: Record<string, string> = {
    "swe@1": "worker-key",
    "re@1": "reviewer-key",
  };
  const credentialIds: Record<string, string> = {
    "worker-key": createIdentity("credential"),
    "reviewer-key": createIdentity("credential"),
  };
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: createIdentity("project"),
  };
  const policies: Record<
    string,
    {
      name: string;
      prompts: {
        instruction_file?: string;
        repository?: string;
        agents: Record<string, string>;
      };
    }
  > = {
    [createIdentity("binding")]: {
      name: "api",
      prompts: {
        ...(options.instructionFile === undefined
          ? {}
          : {
              instruction_file: options.instructionFile,
              repository: REPOSITORY_TEXT,
            }),
        agents: { "swe@1": SWE_BINDING_TEXT, "re@1": RE_BINDING_TEXT },
      },
    },
    [createIdentity("binding")]: {
      name: "web",
      prompts: {
        ...(options.everyBindingNamesFile === true &&
        options.instructionFile !== undefined
          ? { instruction_file: options.instructionFile }
          : {}),
        agents: { "swe@1": SECOND_SWE_TEXT, "re@1": "  " },
      },
    },
  };
  const caller: CallerContext = {
    identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
    context: background,
    requestId: "request",
    execution: claim,
    commit: (fn) => store.transaction(fn),
  };
  const run = (attempt = claim.attempt, executionId = claim.executionId) =>
    executionSetup(
      {
        store,
        promptTelemetry,
        clock: options.clock,
        missionPromptPins: {
          attemptPromptCommits: (_tx, nodeId, pinnedAttempt) => {
            assert.deepEqual([nodeId, pinnedAttempt], [claim.nodeId, attempt]);
            return options.pins?.(pinnedAttempt) ?? null;
          },
          pinPromptCommits: () => {
            throw new Error("UNEXPECTED_COLLABORATION");
          },
        },
        promptBase: {
          instructionBindingsOf: () => {
            throw new Error("UNEXPECTED_COLLABORATION");
          },
          baseCommitOf: () => {
            throw new Error("UNEXPECTED_COLLABORATION");
          },
          instructionFileOf: async (bindingId, commit, context) => {
            assert.ok(options.readFile);
            return options.readFile(bindingId, commit, context);
          },
        },
        agentPrompt: {
          templates: async () => SHIPPED_TEMPLATES,
          framing: async () => shippedFraming(),
          compose: async (agentName: string) => {
            composed.push(agentName);
            if (options.composeDelayMs !== undefined)
              await delay(options.composeDelayMs);
            return (
              options.compose?.(agentName) ?? [
                partOf(PromptPart.Role, `${agentName}.md`, agentName),
              ]
            );
          },
        },
        workerBindingRowOf: () => ({
          binding_id: claim.workerBindingId,
          project_id: claim.projectId,
          resource_identity: `worker:${TWO_AGENT_WORKER}`,
          tombstone: false,
          disabled: false,
          placement: InstancePlacement.Server,
          worker_instances: [],
          worker_name: TWO_AGENT_WORKER,
          entries: [],
          resource_budget: null,
        }),
        pinnedCredentialMetadata: (_tx, _claim, name) => ({
          id: credentialIds[name]!,
          name,
          platform: "anthropic",
          metadata: null,
        }),
        environmentClaimed: () => {},
        environmentDigestOf: () => ENVIRONMENT_DIGEST,
        environmentOf: () => null,
        repositoryBindingIdsOf: (_tx, nodeId, pinnedRevision) => {
          assert.deepEqual(
            [nodeId, pinnedRevision],
            [claim.nodeId, claim.pinnedRevision],
          );
          return Object.keys(policies);
        },
        intentOf: () => ExecutionIntent.Implement,
        repositoryPolicyOf: (_tx, id) => ({
          binding_id: id,
          resource_identity: REPOSITORY_IDENTITY,
          name: policies[id]!.name,
          address: "git@github.com:kanthorlabs/api.git",
          platform: RepositoryPlatform.GitHub,
          ssh_credential: SSH_CREDENTIAL,
          base_branch: "main",
          prompts: policies[id]!.prompts,
          environment: null,
          repository_environment: false,
        }),
        sshHostKeysOf: () => `github.com ${HOST_KEY}\n`,
        custodyHandover: publicKeyCustody,
        schedulerClaims: {
          agentSelectionsOf: () =>
            Object.entries(credentials).map(([agent, credential]) => ({
              agent_name: agent,
              position: 0,
              level: ChainLevel.Enablement,
              agent_provider: "default",
              provider: "anthropic",
              credential,
              model_identifier: "claude-sonnet-4-5",
              reasoning_effort: "off",
            })),
          agentPinsOf: () => ({
            worker_binding_id: claim.workerBindingId,
            pins: Object.keys(credentials).map((agent, position) => ({
              agent_name: agent,
              enablement_id: enablementIds[agent]!,
              position,
            })),
          }),
        },
      },
      {
        declarationOf: twoAgentDeclarationOf,
        placementOf: () => InstancePlacement.Server,
        pinnedAgentView: (_tx, _worker, selection) => ({
          effective: {
            ...setup.agents[0]!.effective_configuration,
            credential: selection.credential,
          },
          valid: true,
          issues: [],
        }),
      },
      { ...caller, execution: { ...claim, attempt, executionId } },
    );
  return {
    run,
    composed,
    promptTelemetry,
    bindingIds: Object.keys(policies),
    credentialIds,
    enablementIds,
    workerBindingId: claim.workerBindingId,
    executionId: claim.executionId,
  };
}

test("setup answers one entry per agent of a two-agent worker with its own prompt, binding prompts and pinned credential", async (t) => {
  const { answer, credentialIds, enablementIds, workerBindingId } =
    await twoAgentAnswer(t, memoryPromptTelemetry());
  assert.deepEqual(
    answer.agents.map((agent) => agent.agent_name),
    ["swe@1", "re@1"],
  );
  assert.deepEqual(
    answer.agents.map((agent) => agent.credential_id),
    [credentialIds["worker-key"], credentialIds["reviewer-key"]],
  );
  assert.deepEqual(
    answer.agents.map((agent) => agent.enablement_id),
    [enablementIds["swe@1"], enablementIds["re@1"]],
  );
  assert.deepEqual(
    answer.agents.map((agent) => agent.worker_binding_id),
    [workerBindingId, workerBindingId],
  );
  const [swe, re] = answer.agents.map((agent) => agent.prompt.final);
  const worker = framing(SHIPPED_TEMPLATES, PromptConsumer.Worker);
  assert.equal(
    swe,
    [
      "swe@1",
      `Binding prompt of repository api:\n\n${SWE_BINDING_TEXT}`,
      `Binding prompt of repository web:\n\n${SECOND_SWE_TEXT}`,
      worker,
    ].join("\n\n"),
  );
  assert.equal(
    re,
    [
      "re@1",
      `Binding prompt of repository api:\n\n${RE_BINDING_TEXT}`,
      worker,
    ].join("\n\n"),
  );
  assert.ok(!re!.includes(SWE_BINDING_TEXT));
  assert.ok(!swe!.includes(RE_BINDING_TEXT));
});

test("setup records the references of each native agent once, with the engine version and no text", async (t) => {
  const telemetry = memoryPromptTelemetry();
  const { answer } = await twoAgentAnswer(t, telemetry);
  const [swe, re] = ["swe@1", "re@1"].map((agentName) =>
    telemetry.promptRecordOf(answer.execution_id, agentName),
  );
  const empty = "0".repeat(64);
  const framingDigest = shippedFraming().digest;
  assert.deepEqual(
    swe!.sources.map(({ part, name, digest }) => [part, name, digest]),
    [
      [PromptPart.Role, "swe@1.md", empty],
      [PromptPart.Binding, "api", digest(SWE_BINDING_TEXT)],
      [PromptPart.Binding, "web", digest(SECOND_SWE_TEXT)],
      [PromptPart.Framing, "framing-worker", framingDigest],
    ],
  );
  assert.deepEqual(
    re!.sources.map(({ part, name, digest }) => [part, name, digest]),
    [
      [PromptPart.Role, "re@1.md", empty],
      [PromptPart.Binding, "api", digest(RE_BINDING_TEXT)],
      [PromptPart.Framing, "framing-worker", framingDigest],
    ],
  );
  assert.deepEqual(
    answer.agents.map(({ prompt }) => prompt.sources),
    [swe!.sources, re!.sources],
  );
  assert.equal(swe!.engine_version, packageVersion());
  assert.equal(swe!.templates_digest, re!.templates_digest);
  assert.ok(!JSON.stringify([swe, re]).includes(SWE_BINDING_TEXT));
});

test("a failed span write or a writer that stores no record fails the setup with prompt_record_failed", async (t) => {
  const refusal = {
    status: HttpStatus.ServiceUnavailable,
    code: WorkerErrorCode.ExecutionPromptRecordFailed,
    details: { agent_name: "swe@1" },
  };
  await assert.rejects(
    twoAgentAnswer(t, {
      agentPrompted: () => {
        throw new Error("TRACKING_DOWN");
      },
      promptRecordOf: () => null,
    }),
    refusal,
  );
  await assert.rejects(
    twoAgentAnswer(t, {
      agentPrompted: () => {},
      promptRecordOf: () => null,
    }),
    refusal,
  );
});

const SSH_UNREACHABLE_STATUS = 422;
const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const PINNED_COMMIT = "a".repeat(40);
const MOVED_COMMIT = "b".repeat(40);
const INSTRUCTION_PATH = "AGENTS.md";
const PINNED_TEXT = "Write every name outside the code in snake_case.";
const MOVED_TEXT = "Write every name outside the code in camelCase.";

function filesAt(
  texts: Record<string, string>,
  reads: string[] = [],
): InstructionFileReader {
  return async (_bindingId, commit) => {
    reads.push(commit);
    const text = texts[commit];
    assert.ok(text !== undefined);
    return {
      path: INSTRUCTION_PATH,
      commit,
      state: InstructionFileState.Present,
      reason: null,
      text,
    };
  };
}

test("setup composes the instruction file at the pinned commit and the stored repository prompt under their headings after the base moves", async (t) => {
  const reads: string[] = [];
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
    readFile: filesAt(
      { [PINNED_COMMIT]: PINNED_TEXT, [MOVED_COMMIT]: MOVED_TEXT },
      reads,
    ),
  });
  const answer = await f.run();
  assert.deepEqual(reads, [PINNED_COMMIT]);
  const [swe, re] = answer.agents.map(({ prompt }) => prompt.final);
  const layerTwo = [
    `Repository prompt of repository api, file ${INSTRUCTION_PATH}:\n\n${PINNED_TEXT}`,
    `Repository prompt of repository api, set in KanthorD:\n\n${REPOSITORY_TEXT}`,
  ].join("\n\n");
  assert.ok(
    swe!.includes(`swe@1\n\n${layerTwo}\n\nBinding prompt of repository api:`),
  );
  assert.ok(
    re!.includes(`re@1\n\n${layerTwo}\n\nBinding prompt of repository api:`),
  );
  assert.ok(!swe!.includes(MOVED_TEXT));
  const file = answer.agents[0]!.prompt.sources[1]!;
  assert.deepEqual(file, {
    part: PromptPart.InstructionFile,
    name: "api",
    origin: PromptOrigin.Repository,
    path: INSTRUCTION_PATH,
    binding_id: bindingOf(f),
    commit: PINNED_COMMIT,
    digest: digest(PINNED_TEXT),
  });
});

test("a new attempt reads the instruction file at its own pinned commit", async (t) => {
  const reads: string[] = [];
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: (attempt) => [
      {
        binding_id: bindingOf(f),
        commit: attempt === FIRST_ATTEMPT ? PINNED_COMMIT : MOVED_COMMIT,
      },
    ],
    readFile: filesAt(
      { [PINNED_COMMIT]: PINNED_TEXT, [MOVED_COMMIT]: MOVED_TEXT },
      reads,
    ),
  });
  const first = await f.run(FIRST_ATTEMPT);
  const second = await f.run(SECOND_ATTEMPT, createIdentity("execution"));
  assert.deepEqual(reads, [PINNED_COMMIT, MOVED_COMMIT]);
  assert.ok(first.agents[0]!.prompt.final.includes(PINNED_TEXT));
  assert.ok(second.agents[0]!.prompt.final.includes(MOVED_TEXT));
});

test("a node-branch change of the instruction file changes no prompt, because the setup reads only the pinned commit", async (t) => {
  const nodeBranchHead = "d".repeat(40);
  const reads: string[] = [];
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
    readFile: filesAt(
      { [PINNED_COMMIT]: PINNED_TEXT, [nodeBranchHead]: MOVED_TEXT },
      reads,
    ),
  });
  const answer = await f.run();
  assert.deepEqual(reads, [PINNED_COMMIT]);
  assert.ok(!answer.agents[0]!.prompt.final.includes(MOVED_TEXT));
});

test("an absent instruction file adds no part", async (t) => {
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
    readFile: async (_bindingId, commit) => ({
      path: INSTRUCTION_PATH,
      commit,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    }),
  });
  const answer = await f.run();
  assert.deepEqual(
    answer.agents[0]!.prompt.sources.map(({ part }) => part),
    [
      PromptPart.Role,
      PromptPart.Repository,
      PromptPart.Binding,
      PromptPart.Binding,
      PromptPart.Framing,
    ],
  );
});

for (const reason of [
  InstructionFileReason.TooLarge,
  InstructionFileReason.NotUtf8,
  InstructionFileReason.Unreadable,
  InstructionFileReason.ControlCharacter,
])
  test(`an instruction file that is ${reason} at the pinned commit answers 409 source_invalid`, async (t) => {
    const f = twoAgentFixture(t, {
      instructionFile: INSTRUCTION_PATH,
      pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
      readFile: async (_bindingId, commit) => ({
        path: INSTRUCTION_PATH,
        commit,
        state: InstructionFileState.Invalid,
        reason,
        text: null,
      }),
    });
    await assert.rejects(f.run(), {
      status: HttpStatus.Conflict,
      code: AgentErrorCode.PromptSourceInvalid,
      details: {
        part: PromptPart.InstructionFile,
        name: "api",
        binding_id: bindingOf(f),
        path: INSTRUCTION_PATH,
        commit: PINNED_COMMIT,
        reason,
      },
    });
  });

test("a failed read of the pinned commit answers its project code", async (t) => {
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
    readFile: async () => {
      throw new OperationError(
        SSH_UNREACHABLE_STATUS,
        ProjectErrorCode.RepositorySshUnreachable,
        "Repository is unreachable.",
        { failure_reason: "deadline_exceeded" },
      );
    },
  });
  await assert.rejects(f.run(), {
    code: ProjectErrorCode.RepositorySshUnreachable,
  });
});

test("a binding that names an instruction file answers 409 prompt_not_pinned with a null pin and with a pin that holds no entry for it", async (t) => {
  for (const pin of [
    null,
    [{ binding_id: "binding_other", commit: PINNED_COMMIT }],
  ]) {
    const f = twoAgentFixture(t, {
      instructionFile: INSTRUCTION_PATH,
      pins: () => pin,
      readFile: async () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    });
    await assert.rejects(f.run(), {
      status: HttpStatus.Conflict,
      code: WorkerErrorCode.ExecutionPromptNotPinned,
      details: { binding_id: bindingOf(f) },
    });
    assert.deepEqual(f.composed, []);
  }
});

test("a retried setup answers the text of the stored span and composes nothing", async (t) => {
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    pins: () => [{ binding_id: bindingOf(f), commit: PINNED_COMMIT }],
    readFile: filesAt({ [PINNED_COMMIT]: PINNED_TEXT }),
    compose: (agentName) => [
      promptPart(
        {
          part: PromptPart.Role,
          name: `${agentName}.md`,
          origin: PromptOrigin.Binary,
          path: null,
          binding_id: null,
          commit: null,
          digest: digest(getAgentDeclaration(agentName)!.agent_prompt),
        },
        PromptPartState.Resolved,
        getAgentDeclaration(agentName)!.agent_prompt,
      ),
    ],
  });
  const first = await f.run();
  const recorded = f.composed.length;
  const retried = await f.run();
  assert.equal(f.composed.length, recorded);
  assert.deepEqual(
    retried.agents.map(({ prompt }) => prompt),
    first.agents.map(({ prompt }) => prompt),
  );
});

test("a retried setup after an agent-directory edit answers 409 source_invalid with reason changed", async (t) => {
  const directory = temporary(t);
  const file = join(directory, "swe@1.md");
  writeFileSync(file, OVERRIDE_TEXT);
  const f = twoAgentFixture(t, {
    compose: (agentName) => [
      promptPart(
        {
          part: PromptPart.Role,
          name: `${agentName}.md`,
          origin: PromptOrigin.File,
          path: file,
          binding_id: null,
          commit: null,
          digest: digest(OVERRIDE_TEXT),
        },
        PromptPartState.Resolved,
        OVERRIDE_TEXT,
      ),
    ],
  });
  await f.run();
  writeFileSync(file, SECOND_SWE_TEXT);
  await assert.rejects(f.run(), {
    status: HttpStatus.Conflict,
    code: AgentErrorCode.PromptSourceInvalid,
    details: {
      part: PromptPart.Role,
      name: "swe@1.md",
      binding_id: null,
      path: file,
      commit: null,
      reason: PromptSourceReason.Changed,
    },
  });
});

function shippedRole(agentName: string): PromptPartAnswer[] {
  const text = getAgentDeclaration(agentName)!.agent_prompt;
  return [
    promptPart(
      {
        part: PromptPart.Role,
        name: `${agentName}.md`,
        origin: PromptOrigin.Binary,
        path: null,
        binding_id: null,
        commit: null,
        digest: digest(text),
      },
      PromptPartState.Resolved,
      text,
    ),
  ];
}

const READ_DELAY_MS = 20;
const BOTH_READS = 2;
const NO_WRITES = 0;

function barrierReader(deadlines: (number | null)[]): InstructionFileReader {
  let inFlight = 0;
  let release = () => {};
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async (_bindingId, commit, context) => {
    deadlines.push(context.deadline);
    inFlight++;
    if (inFlight === BOTH_READS) release();
    await both;
    await delay(READ_DELAY_MS);
    return {
      path: INSTRUCTION_PATH,
      commit,
      state: InstructionFileState.Present,
      reason: null,
      text: PINNED_TEXT,
    };
  };
}

test("one setup reads every instruction file in parallel under one deadline that starts with the setup", async (t) => {
  const deadlines: (number | null)[] = [];
  let reader = barrierReader(deadlines);
  let setupStart = Date.now();
  const f = twoAgentFixture(t, {
    instructionFile: INSTRUCTION_PATH,
    everyBindingNamesFile: true,
    composeDelayMs: READ_DELAY_MS,
    clock: () => setupStart,
    compose: shippedRole,
    pins: () =>
      f.bindingIds.map((binding_id) => ({ binding_id, commit: PINNED_COMMIT })),
    readFile: (bindingId, commit, context) =>
      reader(bindingId, commit, context),
  });
  const composedStart = setupStart;
  await f.run();
  assert.equal(deadlines.length, BOTH_READS);
  for (const deadline of deadlines) {
    assert.ok(deadline !== null);
    assert.ok(deadline <= composedStart + PROMPT_SOURCE_READ_MS);
  }
  deadlines.length = 0;
  let retried = 0;
  const shared = barrierReader(deadlines);
  reader = async (bindingId, commit, context) => {
    retried++;
    if (retried <= BOTH_READS) return shared(bindingId, commit, context);
    deadlines.push(context.deadline);
    return {
      path: INSTRUCTION_PATH,
      commit,
      state: InstructionFileState.Present,
      reason: null,
      text: PINNED_TEXT,
    };
  };
  setupStart += 1;
  const retryStart = setupStart;
  await f.run();
  assert.ok(deadlines.length > BOTH_READS);
  for (const deadline of deadlines) {
    assert.ok(deadline !== null);
    assert.ok(deadline <= retryStart + PROMPT_SOURCE_READ_MS);
  }
});

test("a concurrent first setup that stored other sources makes the setup answer the stored text", async (t) => {
  const records = new Map<string, AgentPromptFacts>();
  const stored = (agentName: string): AgentPromptFacts => {
    const role = getAgentDeclaration(agentName)!.agent_prompt;
    return {
      agent_name: agentName,
      sources: [
        {
          part: PromptPart.Role,
          name: `${agentName}.md`,
          origin: PromptOrigin.Binary,
          path: null,
          binding_id: null,
          commit: null,
          digest: digest(role),
        },
        promptReference(shippedFraming()),
      ],
      templates_digest: "0".repeat(64),
      engine_version: packageVersion(),
    };
  };
  const written: string[] = [];
  const f = twoAgentFixture(t, {
    promptTelemetry: {
      agentPrompted: (_executionId, facts) => {
        written.push(facts.agent_name);
      },
      promptRecordOf: (_executionId, agentName) =>
        written.length === NO_WRITES ? null : (records.get(agentName) ?? null),
    },
  });
  for (const agentName of ["swe@1", "re@1"])
    records.set(agentName, stored(agentName));
  const answer = await f.run();
  assert.deepEqual(written, ["swe@1", "re@1"]);
  for (const agent of answer.agents) {
    assert.equal(
      agent.prompt.final,
      [
        getAgentDeclaration(agent.agent_name)!.agent_prompt,
        framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
      ].join("\n\n"),
    );
    assert.deepEqual(
      agent.prompt.sources,
      records.get(agent.agent_name)!.sources,
    );
  }
});

function bindingOf(f: { bindingIds: string[] }): string {
  const [bindingId] = f.bindingIds;
  assert.ok(bindingId);
  return bindingId;
}

async function repositorySetup(t: TestContext, address: string, pin: boolean) {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([{ service: "repository", migrations: repositoryMigrations }]);
  if (pin)
    store.database
      .prepare(
        "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(createIdentity("host_key"), "github.com", HOST_KEY, Date.now());
  const repository = new RepositoryComponent({ checkTools: () => {} });
  const setup = anthropicSetup();
  const agent = setup.agents[0]!;
  const bindingId = createIdentity("binding");
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_registration"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
    nodeBranch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    attempt: 1,
    projectId: createIdentity("project"),
  };
  const selection: AgentSelection = {
    agent_name: agent.agent_name,
    position: 0,
    level: ChainLevel.Enablement,
    agent_provider: "default",
    provider: agent.effective_configuration.provider,
    credential: agent.effective_configuration.credential,
    model_identifier: agent.effective_configuration.model_identifier,
    reasoning_effort: agent.effective_configuration.reasoning_effort,
  };
  return executionSetup(
    {
      store,
      promptTelemetry: memoryPromptTelemetry(),
      missionPromptPins: NO_PROMPT_PINS,
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
        framing: async () => shippedFraming(),
        compose: async () => promptParts,
      },
      workerBindingRowOf: () => ({
        binding_id: claim.workerBindingId,
        project_id: claim.projectId,
        resource_identity: "worker:coder@1",
        tombstone: false,
        disabled: false,
        placement: InstancePlacement.Server,
        worker_instances: [],
        worker_name: setup.worker_name,
        entries: [],
        resource_budget: null,
      }),
      pinnedCredentialMetadata: (_tx, _claim, name) => ({
        id: agent.credential_id,
        name,
        platform: agent.effective_configuration.provider,
        metadata: null,
      }),
      environmentClaimed: () => {},
      environmentDigestOf: () => ENVIRONMENT_DIGEST,
      environmentOf: () => null,
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        resource_identity: REPOSITORY_IDENTITY,
        name: "repo",
        address,
        platform: RepositoryPlatform.GitHub,
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        prompts: {},
        environment: null,
        repository_environment: true,
      }),
      sshHostKeysOf: (tx, platform, received) =>
        repository.sshHostKeysOf(tx, platform, received),
      custodyHandover: publicKeyCustody,
      schedulerClaims: {
        agentSelectionsOf: () => [selection],
        agentPinsOf: () => ({
          worker_binding_id: claim.workerBindingId,
          pins: [],
        }),
      },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
      placementOf: () => InstancePlacement.Server,
      pinnedAgentView: () => ({
        effective: agent.effective_configuration,
        valid: true,
        issues: [],
      }),
    },
    {
      identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
      context: background,
      requestId: "request",
      execution: claim,
      commit: (fn) => store.transaction(fn),
    },
  );
}

test("setup answers the pinned host key line of each repository and no secret", async (t) => {
  const answer = await repositorySetup(
    t,
    "git@github.com:kanthorlabs/kanthord.git",
    true,
  );
  assert.deepEqual(answer.repositories[0]?.ssh_host_key, {
    known_hosts: `github.com ${HOST_KEY}\n`,
  });
  const text = JSON.stringify(answer);
  assert.equal(text.includes("PRIVATE KEY"), false);
  assert.equal(text.includes(SSH_CREDENTIAL), false);
});

test("setup refuses an unpinned host and an alias host before any answer", async (t) => {
  await assert.rejects(
    repositorySetup(t, "git@github.com:kanthorlabs/kanthord.git", false),
    (error) =>
      error instanceof OperationError &&
      error.code === HostKeyErrorCode.Unpinned,
  );
  await assert.rejects(
    repositorySetup(t, "git@github:kanthorlabs/kanthord.git", true),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.RepositoryAddressInvalid,
  );
  await assert.rejects(
    repositorySetup(
      t,
      "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
      true,
    ),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.RepositoryAddressInvalid,
  );
  await assert.rejects(
    repositorySetup(t, "git@gitlab.com:kanthorlabs/kanthord.git", true),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.RepositoryAddressInvalid,
  );
});
