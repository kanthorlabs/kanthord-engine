import { ExecutionBudget } from "./budget.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import * as connector from "../repository/connector.ts";
import type { Revision, TaskContent } from "../mission/contract.ts";
import { NodeKind, openNativeAgent, type NativeAgent } from "./native-agent.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
  scriptedModelRuntime,
  unusedHostTools,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { ExecutionRun } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot } from "./workspace.ts";
import {
  prepareStepsWorkspace,
  TaskBoundary,
  TaskResultKind,
} from "./steps-objective.ts";
import { reviewedTaskRunner } from "./reviewed-steps.ts";
import { REVIEW_MARKER, REVIEW_ROUNDS } from "./review.ts";
import {
  criterionRevisionInstruction,
  repairInstruction,
} from "./judgement.ts";

const transport = { ...connector, proveSshIdentity: async () => {} };
const JUDGEMENT =
  'kanthord-judgement: {"criterion_met": true, "rationale": "met"}';
const BLOCKER = {
  id: "B1",
  kind: "blocker",
  name: "Missing file",
  description: "b.txt is absent",
  fix: "Write b.txt",
  why: "The default standard",
};
const CLEAN_REVIEW = `${REVIEW_MARKER} {"findings": []}`;
const BLOCKED_REVIEW = `${REVIEW_MARKER} ${JSON.stringify({ findings: [BLOCKER] })}`;
const FIRST_ROUND = 1;
const SECOND_ROUND = 2;

const write = (path: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
    stopReason: "toolUse",
  });

const task: TaskContent = {
  id: createIdentity("node"),
  filename: "greet.md",
  content: {
    name: "greet",
    requirement: "Write a.txt",
    criterion: "a.txt exists",
    verifications: ["test -f a.txt"],
    bindings: [],
  },
};

function fakeReviewer(budget: ExecutionBudget, replies: string[]) {
  const instructions: string[] = [];
  let closed = 0;
  let last: string | undefined;
  const agent = {
    budget,
    async instruct(_work: unknown, text: string) {
      instructions.push(text);
      last = replies.shift();
    },
    lastText: () => last,
  } as unknown as NativeAgent;
  return {
    instructions,
    closed: () => closed,
    sessions: {
      open: async () => agent,
      close: () => {
        closed++;
      },
    },
  };
}

async function fixture(
  t: TestContext,
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
  const setup = anthropicSetup({ worker_name: "developer@1" });
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
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    trace_id: "trace",
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
    key: "test_reviewed_key",
  }));
  const budget = new ExecutionBudget({
    created_at: Date.now(),
    expired_at: Date.now() + 60000,
    resource_budget: setup.resource_budget,
  });
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
    budget,
    workspaceAgentFiles: true,
    workspace: workspace.directory,
    hostHome: temporary(t),
    modelRuntimeFactory: scriptedModelRuntime(provider),
    context: run.operationContext,
  });
  t.after(() => agent.dispose());
  return {
    state: {
      input,
      run,
      agent,
      revision: { tasks: [task] } as Revision,
      ...workspace,
      priorRationale: null,
    },
    budget,
    provider,
  };
}

test("a clean first review completes the task after one review round", async (t) => {
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, [CLEAN_REVIEW]);
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.equal(reviewer.instructions.length, FIRST_ROUND);
  assert.equal(reviewer.closed(), FIRST_ROUND);
  assert.ok(reviewer.instructions[0]!.includes("+++ b/a.txt"));
  assert.ok(reviewer.instructions[0]!.includes("Earlier findings: []"));
});

test("a blocker leads to a fix round and a second review with the earlier findings and the reply", async (t) => {
  const reply = "B1 - status:FIXED - action:YES - Missing file";
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
    write("b.txt"),
    fauxAssistantMessage(reply),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, [BLOCKED_REVIEW, CLEAN_REVIEW]);
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.equal(reviewer.instructions.length, SECOND_ROUND);
  const second = reviewer.instructions[1]!;
  assert.ok(second.includes(JSON.stringify([BLOCKER])));
  assert.ok(second.includes(reply));
  assert.ok(second.includes("+++ b/b.txt"));
  assert.ok(second.includes("+++ b/a.txt"));
});

test("a fix round that commits nothing ends the review of the task", async (t) => {
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
    fauxAssistantMessage("B1 - status:OPEN - action:NO - Missing file"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, [BLOCKED_REVIEW]);
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.equal(reviewer.instructions.length, FIRST_ROUND);
});

test("the review stops after the round cap while a blocker stands", async (t) => {
  const script: Parameters<typeof scriptedProvider>[0] = [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
  ];
  for (let round = 0; round < REVIEW_ROUNDS; round++)
    script.push(
      write(`fix-${round}.txt`),
      fauxAssistantMessage("fixed"),
      fauxAssistantMessage(JUDGEMENT),
    );
  const h = await fixture(t, script);
  const reviewer = fakeReviewer(
    h.budget,
    Array.from({ length: REVIEW_ROUNDS }, () => BLOCKED_REVIEW),
  );
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.equal(reviewer.instructions.length, REVIEW_ROUNDS);
  assert.equal(reviewer.closed(), REVIEW_ROUNDS);
});

test("two review replies without the review line end the review and keep the task result", async (t) => {
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, ["no verdict", "still no verdict"]);
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.deepEqual(reviewer.instructions.slice(1), [
    repairInstruction(REVIEW_MARKER),
  ]);
  assert.equal(reviewer.closed(), FIRST_ROUND);
});

test("one review reply without the review line gets a repair turn and the repaired review stands", async (t) => {
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
    write("b.txt"),
    fauxAssistantMessage("B1 - status:FIXED - action:YES - Missing file"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, [
    "no verdict",
    BLOCKED_REVIEW,
    CLEAN_REVIEW,
  ]);
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.InProgress,
    null,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.equal(reviewer.instructions[1], repairInstruction(REVIEW_MARKER));
  assert.ok(reviewer.instructions[2]!.includes(JSON.stringify([BLOCKER])));
  assert.equal(reviewer.closed(), SECOND_ROUND);
});

test("a start-check revision instruction opens the first work turn of a reviewed task", async (t) => {
  const h = await fixture(t, [
    write("a.txt"),
    fauxAssistantMessage("done"),
    fauxAssistantMessage(JUDGEMENT),
  ]);
  const reviewer = fakeReviewer(h.budget, [CLEAN_REVIEW]);
  const revision = criterionRevisionInstruction(
    "The edge case stays unhandled",
  );
  const result = await reviewedTaskRunner(reviewer.sessions)(
    h.state,
    task,
    TaskBoundary.RunPassed,
    revision,
  );
  assert.deepEqual(result, { kind: TaskResultKind.Complete });
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(revision));
});
