import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import * as transport from "../repository/connector.ts";
import type { Revision, TaskContent } from "../mission/contract.ts";
import { WorkerMethod } from "./contract.ts";
import { NodeKind, openNativeAgent } from "./native-agent.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  scriptedProvider,
  scriptedModelRuntime,
} from "./test-support.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot, WorkspaceKind } from "./workspace.ts";
import { prepareStepsWorkspace, startCheck } from "./steps-objective.ts";

const SECRET = "test_steps_key";
const TWO = 2;
const task = (name: string, command: string): TaskContent => ({
  id: createIdentity("node"),
  filename: `${name}.md`,
  content: {
    name,
    requirement: name,
    criterion: name,
    verifications: [command],
    bindings: [],
  },
});

async function fixture(
  t: TestContext,
  tasks: TaskContent[],
  script: Parameters<typeof scriptedProvider>[0],
) {
  const state = temporary(t);
  const origin = temporary(t);
  const git = simpleGit(origin);
  await git.init();
  await git.raw(["checkout", "-b", "main"]);
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(origin, "file"), "base");
  await git.add("file");
  await git.commit("base");
  const bare = join(state, "origin.git");
  await git.clone(origin, bare, ["--bare"]);
  const setup = anthropicSetup();
  setup.repositories = [
    {
      bindingId: createIdentity("binding"),
      name: "repo",
      address: bare,
      strategy: { baseBranch: "main" },
      projectPrompt: null,
    },
  ];
  const claim = {
    executionId: setup.executionId,
    nodeId: createIdentity("node"),
    attempt: 1,
    pinnedRevision: 1,
    createdAt: Date.now(),
    expiredAt: Date.now() + 60000,
    traceId: "trace",
  };
  const input = {
    claim,
    setup,
    workspaces: WorkspaceRoot.open(state),
    transport,
  };
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
  t.after(() => run.dispose());
  const workspace = await prepareStepsWorkspace(input, run);
  await simpleGit(workspace.directory).addConfig("user.name", "Test");
  await simpleGit(workspace.directory).addConfig(
    "user.email",
    "test@example.invalid",
  );
  const provider = scriptedProvider(script);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: SECRET,
  }));
  const agent = await openNativeAgent({
    setup,
    claim,
    nodeKind: NodeKind.Objective,
    method: WorkerMethod.Steps,
    credentials,
    handoverItem: { credentialId: setup.credentialId, providerId: "anthropic" },
    workspace: workspace.directory,
    hostHome: temporary(t),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context: run.operationContext,
  });
  t.after(() => agent.dispose());
  return {
    input,
    run,
    agent,
    revision: { tasks } as Revision,
    ...workspace,
    provider,
    bare,
  };
}

test("start check judges passing tasks in order and discards verification changes", async (t) => {
  const tasks = [
    task("failed", "touch dirty; false"),
    task("met", "true"),
    task("unmet", "true"),
  ];
  const h = await fixture(t, tasks, [
    fauxAssistantMessage(
      'kanthord-judgement: {"criterionMet":true,"rationale":"met"}',
    ),
    fauxAssistantMessage(
      'kanthord-judgement: {"criterionMet":false,"rationale":"unmet"}',
    ),
  ]);
  assert.deepEqual(
    (await startCheck(h)).map(({ id }) => id),
    [tasks[0]!.id, tasks[2]!.id],
  );
  assert.equal(h.provider.calls.length, TWO);
  assert.equal(existsSync(join(h.directory, "dirty")), false);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(tasks[1]!.id));
  assert.ok(JSON.stringify(h.provider.calls[1]).includes(tasks[2]!.id));
  h.input.workspaces.release(
    h.input.workspaces.objectiveKey(h.input.claim.nodeId),
    WorkspaceKind.Objective,
  );
});
