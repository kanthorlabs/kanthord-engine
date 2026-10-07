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
import { anthropicSetup, WORKING_LAYER_ALL_ON } from "./test-support.ts";
import { WorkerErrorCode } from "./contract.ts";

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
  const entry = {
    agent: setup.agentName,
    agentProvider: "default",
    modelIdentifier: setup.effectiveConfiguration.model_identifier,
    reasoningEffort: "low",
  };
  const composed: string[] = [];
  let commits = 0;
  const claim = {
    executionId: setup.executionId,
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
    nodeId: createIdentity("node"),
    pinnedRevision: 1,
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
      compose: async (agentName: string) => {
        composed.push(agentName);
        return promptLayers;
      },
    },
    workerBindingRowOf: () => ({
      bindingId: claim.workerBindingId,
      projectId: claim.projectId,
      resourceIdentity: "worker:general@1",
      tombstone: false,
      disabled: false,
      workerName: setup.workerName,
      entries: [entry],
      resourceBudget: null,
    }),
    pinnedCredentialMetadata: () => ({
      id: setup.credentialId,
      name: setup.effectiveConfiguration.credential,
      platform: setup.effectiveConfiguration.provider,
      metadata: null,
    }),
    repositoryBindingIdsOf: () => [],
    repositoryPolicyOf: () => null,
    credentialMetadata: () => null,
  };
  const worker = {
    declarationOf: (name: string) => getWorkerDeclaration(name) ?? null,
    workerAgentView: (
      ...args: Parameters<
        import("./service.ts").WorkerService["workerAgentView"]
      >
    ) => {
      assert.deepEqual(args[3], {
        agentProvider: entry.agentProvider,
        modelIdentifier: entry.modelIdentifier,
        reasoningEffort: entry.reasoningEffort,
      });
      assert.ok(args[4]);
      return {
        defaults: null,
        effective: {
          ...setup.effectiveConfiguration,
          reasoning_effort: entry.reasoningEffort,
        },
        valid: true,
        issues: [],
      };
    },
  };
  const before = commits;
  const answer = await executionSetup(dependencies, worker, caller);
  assert.deepEqual(composed, [setup.agentName]);
  assert.deepEqual(answer.prompt, {
    final: systemPrompt(promptLayers, PromptConsumer.Worker),
  });
  assert.ok(answer.prompt.final.endsWith(framing(PromptConsumer.Worker)));
  assert.ok(answer.prompt.final.includes(SYSTEM_TEXT));
  assert.ok(answer.prompt.final.includes(AGENT_TEXT));
  assert.ok(!answer.prompt.final.includes(WORKING_TEXT));
  assert.equal(
    answer.effectiveConfiguration.reasoning_effort,
    entry.reasoningEffort,
  );
  assert.equal(commits, before + 1);
  await assert.rejects(
    executionSetup(
      dependencies,
      { ...worker, declarationOf: () => getWorkerDeclaration("claude@1")! },
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
      repositoryPolicyOf: () => ({
        bindingId,
        name: "repo",
        address: "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
        sshCredential: SSH_CREDENTIAL,
        baseBranch: "main",
        projectPrompt: null,
        workingLayer,
      }),
      credentialMetadata: (_tx, name) =>
        name === SSH_CREDENTIAL
          ? { platform: "ssh", metadata: sshIdentity }
          : null,
    },
    worker,
    caller,
  );
  assert.deepEqual(pinned.repositories[0]?.sshIdentity, sshIdentity);
  assert.deepEqual(pinned.repositories[0]?.working_layer, workingLayer);
});
