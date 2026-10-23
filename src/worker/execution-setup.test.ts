import assert from "node:assert/strict";
import { EnvironmentSource } from "../project/contract.ts";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { Store } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { executionSetup } from "./execution-setup.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
  ChainLevel,
  PromptLayerKind,
  PromptOrigin,
  PromptSourceState,
} from "../agent/contract.ts";
import { PromptLayer } from "../agent/prompt-composer.ts";
import type { ResolvedLayer } from "../agent/prompt-layers.ts";
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
  WORKING_LAYER_ALL_ON,
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

const SSH_CREDENTIAL = "kanthorlabs-ssh";
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const NO_REQUESTS = 0;
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
const SYSTEM_TEXT = "system layer text";
const AGENT_TEXT = "agent layer text";
const WORKING_TEXT = "working layer text";

function layerOf(
  layer: PromptLayerKind,
  name: PromptLayer,
  text: string,
): ResolvedLayer {
  return {
    layer,
    name,
    enabled: true,
    sources: [
      {
        source: "custom",
        origin: PromptOrigin.Database,
        path: null,
        enabled: true,
        state: PromptSourceState.Present,
        reason: null,
        digest: "0".repeat(64),
        text,
        owner: "owner",
        label: "label",
      },
    ],
  };
}

const promptLayers = [
  layerOf(PromptLayerKind.System, PromptLayer.SystemLayer, SYSTEM_TEXT),
  layerOf(PromptLayerKind.Agent, PromptLayer.AgentLayer, AGENT_TEXT),
  layerOf(PromptLayerKind.Working, PromptLayer.WorkingLayer, WORKING_TEXT),
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
  const dependencies = {
    store,
    agentPrompt: {
      templates: async () => SHIPPED_TEMPLATES,
      compose: async (agentName: string) => {
        composed.push(agentName);
        return promptLayers;
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
    final: systemPrompt(promptLayers, PromptConsumer.Worker, SHIPPED_TEMPLATES),
  });
  assert.ok(
    answered.prompt.final.endsWith(
      framing(SHIPPED_TEMPLATES, PromptConsumer.Worker),
    ),
  );
  assert.ok(answered.prompt.final.includes(SYSTEM_TEXT));
  assert.ok(answered.prompt.final.includes(AGENT_TEXT));
  assert.ok(!answered.prompt.final.includes(WORKING_TEXT));
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
  const bindingId = createIdentity("binding");
  const workingLayer = { ...WORKING_LAYER_ALL_ON, claude_md: false };
  const address = "git@github.com:kanthorlabs/kanthord.git";
  const knownHosts = `github.com ${HOST_KEY}\n`;
  const pinned = await executionSetup(
    {
      ...dependencies,
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        name: "repo",
        address,
        platform: RepositoryPlatform.GitHub,
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        project_prompt: null,
        working_layer: workingLayer,
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
  await assert.rejects(
    executionSetup(
      {
        ...dependencies,
        repositoryBindingIdsOf: () => [bindingId],
        repositoryPolicyOf: () => ({
          binding_id: bindingId,
          name: "repo",
          address,
          platform: RepositoryPlatform.GitHub,
          ssh_credential: SSH_CREDENTIAL,
          base_branch: "main",
          project_prompt: null,
          working_layer: workingLayer,
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
  assert.deepEqual(pinned.repositories[0]?.working_layer, workingLayer);
  const stored = { image: "debian", postCreateCommand: "make deps" };
  const environmentOf = async (
    environment: typeof stored | null,
    placement: InstancePlacement,
    repositoryEnvironment = true,
  ) =>
    (
      await executionSetup(
        {
          ...dependencies,
          workerBindingRowOf: () => ({
            ...dependencies.workerBindingRowOf(),
            placement,
          }),
          repositoryBindingIdsOf: () => [bindingId],
          repositoryPolicyOf: () => ({
            binding_id: bindingId,
            name: "repo",
            address,
            platform: RepositoryPlatform.GitHub,
            ssh_credential: SSH_CREDENTIAL,
            base_branch: "main",
            project_prompt: null,
            working_layer: workingLayer,
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
    });
  assert.deepEqual(await environmentOf(null, InstancePlacement.Container), {
    source: EnvironmentSource.Repository,
  });
  assert.equal(
    await environmentOf(null, InstancePlacement.Container, false),
    null,
  );
  assert.equal(await environmentOf(null, InstancePlacement.Server), null);
  assert.equal(await environmentOf(null, InstancePlacement.Worker), null);
});

test("setup answers one entry per agent of a two-agent worker with its own prompt and pinned credential", async (t) => {
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
          layerOf(PromptLayerKind.Agent, PromptLayer.AgentLayer, agentName),
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
      repositoryBindingIdsOf: () => [],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => null,
      sshHostKeysOf: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
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
  assert.ok(answer.agents[0]!.prompt.final.includes("swe@1"));
  assert.ok(answer.agents[1]!.prompt.final.includes("re@1"));
  assert.ok(!answer.agents[1]!.prompt.final.includes("swe@1"));
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
        compose: async () => promptLayers,
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
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        name: "repo",
        address,
        platform: RepositoryPlatform.GitHub,
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        project_prompt: null,
        working_layer: WORKING_LAYER_ALL_ON,
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
