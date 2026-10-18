import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { Store } from "../kernel/store.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { OperationError } from "../kernel/errors.ts";
import { executionSetup } from "./execution-setup.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
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
  TWO_AGENT_WORKER,
  twoAgentDeclarationOf,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { WorkerErrorCode } from "./contract.ts";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import { ExecutionIntent } from "./contract.ts";
import type { AgentSelection } from "../scheduler/contract.ts";

const SSH_CREDENTIAL = "kanthorlabs-ssh";
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
    position: 0,
    level: "enablement",
    agent_provider: entry.agent_provider,
    provider: agent.effective_configuration.provider,
    credential: "pinned-key",
    model_identifier: entry.model_identifier,
    reasoning_effort: entry.reasoning_effort,
  };
  const composed: string[] = [];
  let commits = 0;
  const claim = {
    executionId: setup.execution_id,
    runtimeIdentity: createIdentity("worker_instance"),
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
      worker_name: setup.worker_name,
      entries: [entry],
      resource_budget: null,
    }),
    pinnedCredentialMetadata: (
      _tx: unknown,
      _claim: unknown,
      name: string,
    ) => ({
      id: agent.credential_id,
      name,
      platform: agent.effective_configuration.provider,
      metadata: null,
    }),
    repositoryBindingIdsOf: () => [],
    intentOf: () => ExecutionIntent.Implement,
    repositoryPolicyOf: () => null,
    credentialMetadata: () => null,
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
  const sshIdentity = {
    host: "kanthorlabs.github.com",
    hostname: "ssh.github.com",
    port: 443,
    identity_file: "~/.ssh/id_kanthorlabs",
  };
  const pinned = await executionSetup(
    {
      ...dependencies,
      repositoryBindingIdsOf: () => [bindingId],
      intentOf: () => ExecutionIntent.Implement,
      repositoryPolicyOf: () => ({
        binding_id: bindingId,
        name: "repo",
        address: "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
        ssh_credential: SSH_CREDENTIAL,
        base_branch: "main",
        project_prompt: null,
        working_layer: workingLayer,
      }),
      credentialMetadata: (_tx, name) =>
        name === SSH_CREDENTIAL
          ? { platform: "ssh", metadata: sshIdentity }
          : null,
    },
    worker,
    caller,
  );
  assert.deepEqual(pinned.repositories[0]?.ssh_identity, sshIdentity);
  assert.deepEqual(pinned.repositories[0]?.working_layer, workingLayer);
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
    runtimeIdentity: createIdentity("worker_instance"),
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
      credentialMetadata: () => null,
      schedulerClaims: {
        agentSelectionsOf: () =>
          Object.entries(credentials).map(([agent, credential]) => ({
            agent_name: agent,
            position: 0,
            level: "enablement",
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
