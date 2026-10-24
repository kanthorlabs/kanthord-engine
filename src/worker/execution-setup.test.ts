import assert from "node:assert/strict";
import type { Environment } from "../kernel/devcontainer.ts";
import { EnvironmentSource } from "../project/contract.ts";
import { setImmediate as turn } from "node:timers/promises";
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
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
} from "../agent/contract.ts";
import { getAgentDeclaration } from "../agent/catalog.ts";
import { resolveAgentPrompt } from "../agent/prompt-files.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  framing,
  PromptConsumer,
  systemPrompt,
} from "../agent/prompt-render.ts";
import {
  anthropicSetup,
  TEST_SSH_PUBLIC_KEY,
  TWO_AGENT_WORKER,
  twoAgentDeclarationOf,
} from "./test-support.ts";
import { WorkerErrorCode } from "./contract.ts";
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
import { ProjectErrorCode, RepositoryPlatform } from "../project/contract.ts";
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

function partOf(
  part: PromptPart,
  name: string,
  text: string,
): PromptPartAnswer {
  return {
    part,
    name,
    origin: PromptOrigin.File,
    path: null,
    digest: "0".repeat(64),
    text,
  };
}

const promptParts = [
  partOf(PromptPart.Standard, "base.md", STANDARD_TEXT),
  partOf(PromptPart.Role, "swe@1.md", AGENT_TEXT),
];

test("setup answers the system and agent prompt after its single snapshot and supports a pinned entry", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
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
    agentPrompt: {
      templates: async () => SHIPPED_TEMPLATES,
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
    schedulerClaims: { agentSelectionsOf: () => [selection] },
  };
  const worker = {
    declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
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
    agentPrompt: {
      templates: async () => SHIPPED_TEMPLATES,
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
  await assert.rejects(executionSetup(resolving, worker, caller), {
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
          environmentOf: () => recorded,
          workerBindingRowOf: () => ({
            ...dependencies.workerBindingRowOf(),
            placement,
          }),
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
        worker,
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
        workerBindingRowOf: () => ({
          ...dependencies.workerBindingRowOf(),
          placement,
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
      worker,
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
  t.after(() => store.close());
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
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
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
      },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
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

test("setup of a container worker binding with an environment claims inside a real transaction and its compute reads the binding facts", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
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
  t.after(() => onboarding.stop());
  const bindingId = createIdentity("binding");
  const answer = await executionSetup(
    {
      store,
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
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
      },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
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

test("setup answers one entry per agent of a two-agent worker with its own prompt, binding prompts and pinned credential", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close());
  const setup = anthropicSetup();
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
    { name: string; prompts: Record<string, string> }
  > = {
    [createIdentity("binding")]: {
      name: "api",
      prompts: { "swe@1": SWE_BINDING_TEXT, "re@1": RE_BINDING_TEXT },
    },
    [createIdentity("binding")]: {
      name: "web",
      prompts: { "swe@1": SECOND_SWE_TEXT, "re@1": "  " },
    },
  };
  const caller: CallerContext = {
    identity: testHumanIdentity("ulrich", "Ulrich", "jti"),
    context: background,
    requestId: "request",
    execution: claim,
    commit: (fn) => store.transaction(fn),
  };
  const answer = await executionSetup(
    {
      store,
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
        compose: async (agentName: string) => [
          partOf(PromptPart.Role, `${agentName}.md`, agentName),
        ],
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
      },
    },
    {
      declarationOf: twoAgentDeclarationOf,
      pinnedAgentView: (_tx, _worker, selection) => ({
        effective: {
          ...setup.agents[0]!.effective_configuration,
          credential: selection.credential,
        },
        valid: true,
        issues: [],
      }),
    },
    caller,
  );
  assert.deepEqual(
    answer.agents.map((agent) => agent.agent_name),
    ["swe@1", "re@1"],
  );
  assert.deepEqual(
    answer.agents.map((agent) => agent.credential_id),
    [credentialIds["worker-key"], credentialIds["reviewer-key"]],
  );
  const [swe, re] = answer.agents.map((agent) => agent.prompt.final);
  const worker = framing(SHIPPED_TEMPLATES, PromptConsumer.Worker);
  assert.equal(
    swe,
    [
      "swe@1",
      `Instructions of repository api:\n\n${SWE_BINDING_TEXT}`,
      `Instructions of repository web:\n\n${SECOND_SWE_TEXT}`,
      worker,
    ].join("\n\n"),
  );
  assert.equal(
    re,
    [
      "re@1",
      `Instructions of repository api:\n\n${RE_BINDING_TEXT}`,
      worker,
    ].join("\n\n"),
  );
  assert.ok(!re!.includes(SWE_BINDING_TEXT));
  assert.ok(!swe!.includes(RE_BINDING_TEXT));
});

async function repositorySetup(t: TestContext, address: string, pin: boolean) {
  const store = new Store(":memory:");
  t.after(() => store.close());
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
      agentPrompt: {
        templates: async () => SHIPPED_TEMPLATES,
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
      schedulerClaims: { agentSelectionsOf: () => [selection] },
    },
    {
      declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
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
