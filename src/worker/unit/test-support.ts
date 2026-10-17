import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createModelRuntime, resolveModel } from "../../llm/model-connector.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  scriptedProvider,
  type ScriptedProvider,
} from "../../agent/test-support.ts";
import { background } from "../../kernel/context.ts";
import {
  fixtureTemplate,
  temporary,
  hostEnvironment,
} from "../../kernel/test-support.ts";
import { createIdentity } from "../../kernel/identity.ts";
import * as connector from "../../repository/connector.ts";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import {
  anthropicSetup,
  unusedHostTools,
  WORKING_LAYER_ALL_ON,
} from "../test-support.ts";
import {
  modelConnectorInput,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
import { ExecutionBudget } from "./budget.ts";
import { NodeKind, openNativeAgent } from "./native-agent.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { prepareStepsWorkspace } from "./steps-objective.ts";
export {
  scriptedProvider,
  type ScriptedProvider,
} from "../../agent/test-support.ts";
export {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";
export * from "../test-support.ts";

export function scriptedModelRuntime(
  provider: ScriptedProvider,
): ModelRuntimeFactory {
  assert.ok(provider.provider);
  assert.ok(provider.calls);
  return async (input) => {
    const runtime = await createModelRuntime(
      await loadPi(),
      modelConnectorInput(input),
    );
    runtime.registerNativeProvider(provider.provider);
    return {
      runtime,
      model: resolveModel(runtime, input.agent.effective_configuration),
    };
  };
}

export const transport = { ...connector, proveSshIdentity: async () => {} };

const SECRET = "test_steps_key";
export const NO_PROVIDER_CALLS = 0;
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const USER_CONFIG = "[user]\n\tname = Test\n\temail = test@example.invalid\n";
const BARE_NAME = "origin.git";
const bareTemplate = fixtureTemplate(async (root) => {
  const origin = join(root, "origin");
  mkdirSync(origin);
  const git = simpleGit(origin);
  await git.raw(["init", "-b", "main"]);
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  await git.raw([...IDENTITY, "commit", "-m", "base"]);
  await git.clone(origin, join(root, BARE_NAME), ["--bare"]);
  rmSync(origin, { recursive: true });
});
export const repositorySetup = () => ({
  binding_id: createIdentity("binding"),
  name: "repo",
  address: "git@github.com:owner/repo.git",
  ssh_identity: {
    host: "github.com",
    hostname: "github.com",
    port: 22,
    identity_file: "~/.ssh/id_test",
  },
  strategy: { base_branch: "main" },
  project_prompt: null,
  working_layer: WORKING_LAYER_ALL_ON,
});

export const task = (name: string, command: string): TaskContent => ({
  id: createIdentity("task"),
  filename: `${name}.md`,
  content: {
    name,
    requirement: name,
    criterion: name,
    verifications: [command],
    bindings: [],
  },
});

export async function objectiveFixture(
  t: TestContext,
  tasks: TaskContent[],
  script: Parameters<typeof scriptedProvider>[0],
  turns?: number,
) {
  const state = temporary(t);
  const bare = join((await bareTemplate(t)).root, BARE_NAME);
  const setup = anthropicSetup();
  if (turns) setup.resource_budget.turns = turns;
  setup.repositories = [
    {
      binding_id: createIdentity("binding"),
      name: "repo",
      address: bare,
      ssh_identity: {
        host: "github.com",
        hostname: "github.com",
        port: 22,
        identity_file: "~/.ssh/id_test",
      },
      strategy: { base_branch: "main" },
      project_prompt: null,
      working_layer: WORKING_LAYER_ALL_ON,
    },
  ];
  const claim = {
    execution_id: setup.execution_id,
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const input = {
    claim,
    setup,
    workspaces: WorkspaceRoot.open(state),
    transport,
    env: hostEnvironment(),
  };
  const run = new ExecutionRun({
    claim,
    clients: {
      mission: {
        "execution.evidence.list": async () => ({
          type: "completed",
          status: 200,
          data: { items: [], next_cursor: null },
        }),
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspace = await prepareStepsWorkspace(input, run);
  appendFileSync(join(workspace.directory, ".git", "config"), USER_CONFIG);
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: SECRET,
  }));
  const agent = await openNativeAgent({
    hostTools: unusedHostTools,
    setup,
    claim,
    nodeKind: NodeKind.Objective,
    agent: setup.agents[0]!,
    credential: {
      credential_id: setup.agents[0]!.credential_id,
      provider_id: "anthropic",
      store: credentials,
    },
    budget: new ExecutionBudget({
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      resource_budget: setup.resource_budget,
    }),
    workspaceAgentFiles: true,
    workspace: workspace.directory,
    hostHome: temporary(t),
    env: hostEnvironment(),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context: run.operationContext,
  });
  t.after(() => agent.dispose());
  return {
    input,
    run,
    agent,
    revision: {
      filename: "objective.md",
      content: {
        name: "objective",
        requirement: "objective",
        criterion: "objective",
        verifications: ["true"],
        bindings: [],
      },
      tasks,
    } as unknown as Revision,
    ...workspace,
    priorRationale: null as string | null,
    rework: false,
    provider,
    bare,
  };
}

export async function advanceBase(
  h: { bare: string },
  t: TestContext,
  content: string,
  path = "file",
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(h.bare, clone, ["--branch", "main"]);
  writeFileSync(join(clone, path), content);
  await git.add(path);
  await git.raw([...IDENTITY, "commit", "-m", `base change of ${path}`]);
  await git.push("origin", "main");
}

export async function commitOnNode(directory: string, content: string) {
  writeFileSync(join(directory, "file"), content);
  await simpleGit(directory).add("file");
  await simpleGit(directory).commit("node change");
}

export function recordReleases(
  h: Awaited<ReturnType<typeof objectiveFixture>>,
) {
  const bodies: unknown[] = [];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  return bodies;
}
