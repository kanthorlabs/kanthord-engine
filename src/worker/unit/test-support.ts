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
import {
  DEFAULT_SSH_PORT,
  LOCAL_GIT_SSH_ACCESS,
} from "../../repository/test-sshd.ts";
import type { Revision, TaskContent } from "../../mission/contract.ts";
import {
  anthropicSetup,
  TEST_SSH_HOST_KEY,
  TEST_SSH_PUBLIC_KEY,
  unusedHostTools,
  WORKING_LAYER_ALL_ON,
} from "../test-support.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  modelConnectorInput,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
import { ExecutionIntent, type RepositoryTransport } from "../contract.ts";
import { ExecutionBudget } from "./budget.ts";
import { openNativeAgent } from "./native-agent.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot } from "./workspace.ts";
import { prepareStepsWorkspace } from "./steps-implement.ts";
import type { Verdict } from "./node-reads.ts";
export { LOCAL_GIT_SSH_ACCESS } from "../../repository/test-sshd.ts";
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

export const transport: RepositoryTransport = {
  clone: (address, directory, context, deadlineMs) =>
    connector.clone(
      address,
      directory,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  fetchAndCheckout: (directory, branch, base, pushed, context, deadlineMs) =>
    connector.fetchAndCheckout(
      directory,
      branch,
      base,
      pushed,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  fetchBase: (directory, base, context, deadlineMs) =>
    connector.fetchBase(
      directory,
      base,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  pushNodeBranch: (directory, branch, context, deadlineMs) =>
    connector.pushNodeBranch(
      directory,
      branch,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
  cloneSnapshot: (address, revision, directory, context, deadlineMs) =>
    connector.cloneSnapshot(
      address,
      revision,
      directory,
      context,
      deadlineMs,
      LOCAL_GIT_SSH_ACCESS,
    ),
};

export const TEST_SSH_ACCESS: SshAccess = {
  private_key: "test_private_key",
  public_key: "ssh-ed25519 test_public_key",
  known_hosts: TEST_SSH_HOST_KEY.known_hosts,
  port: DEFAULT_SSH_PORT,
};

class EveryBindingSshAccess extends Map<string, SshAccess> {
  override get(): SshAccess {
    return TEST_SSH_ACCESS;
  }
}

export const everyBindingSshAccess: ReadonlyMap<string, SshAccess> =
  new EveryBindingSshAccess();

export function testSshAccess(
  repositories: readonly { binding_id: string }[],
): Map<string, SshAccess> {
  return new Map(
    repositories.map(({ binding_id }) => [
      binding_id,
      {
        private_key: `test_private_key_${binding_id}`,
        public_key: `ssh-ed25519 test_${binding_id}`,
        known_hosts: TEST_SSH_HOST_KEY.known_hosts,
        port: DEFAULT_SSH_PORT,
      },
    ]),
  );
}

export const STEPS_KEY = "test_steps_key";
export const NO_PROVIDER_CALLS = 0;
const IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const USER_CONFIG = "[user]\n\tname = Test\n\temail = test@example.invalid\n";
const BARE_NAME = "origin.git";
const DEFAULT_BINDING_NAME = "repo";
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
  ssh_host_key: TEST_SSH_HOST_KEY,
  ssh_public_key: TEST_SSH_PUBLIC_KEY,
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

export async function implementFixture(
  t: TestContext,
  tasks: TaskContent[],
  script: Parameters<typeof scriptedProvider>[0],
  turns?: number,
  names: readonly string[] = [DEFAULT_BINDING_NAME],
) {
  const state = temporary(t);
  const bares = await Promise.all(
    names.map(async () => join((await bareTemplate(t)).root, BARE_NAME)),
  );
  const setup = anthropicSetup();
  if (turns) setup.resource_budget.turns = turns;
  setup.repositories = names.map((name, index) => ({
    binding_id: createIdentity("binding"),
    name,
    address: bares[index]!,
    ssh_host_key: TEST_SSH_HOST_KEY,
    ssh_public_key: TEST_SSH_PUBLIC_KEY,
    strategy: { base_branch: "main" },
    project_prompt: null,
    working_layer: WORKING_LAYER_ALL_ON,
  }));
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
    sshAccess: testSshAccess(setup.repositories),
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
    secrets: async () => [STEPS_KEY],
  });
  t.after(() => run.dispose());
  const workspace = await prepareStepsWorkspace(input, run);
  for (const checkout of workspace.checkouts)
    appendFileSync(join(checkout.directory, ".git", "config"), USER_CONFIG);
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: STEPS_KEY,
  }));
  const agent = await openNativeAgent({
    hostTools: unusedHostTools,
    setup,
    claim,
    intent: ExecutionIntent.Implement,
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
    workspace: workspace.root,
    checkouts: workspace.checkouts.map((checkout) => checkout.directory),
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
      filename: "implement.md",
      content: {
        name: "implement",
        requirement: "implement",
        criterion: "implement",
        verifications: ["true"],
        bindings: [],
      },
      tasks,
    } as unknown as Revision,
    ...workspace,
    verdict: null as Verdict | null,
    cleared: null as string | null,
    unchangedTurns: 0,
    provider,
    bare: bares[0]!,
    bares,
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
  h: Awaited<ReturnType<typeof implementFixture>>,
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
