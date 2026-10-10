import { ExecutionBudget } from "./budget.ts";
import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { background } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import * as connector from "../repository/connector.ts";
import type { Revision, TaskContent } from "../mission/contract.ts";
import { NodeKind, openNativeAgent } from "./native-agent.ts";
import {
  anthropicSetup,
  fauxAssistantMessage,
  fauxToolCall,
  scriptedProvider,
  scriptedModelRuntime,
  WORKING_LAYER_ALL_ON,
} from "./test-support.ts";
import { EndReason, ExecutionRun, ExecutionStop } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import {
  criterionRevisionInstruction,
  JUDGEMENT_MARKER,
  repairInstruction,
} from "./judgement.ts";
import type { MethodClients } from "./method-clients.ts";
import { WorkspaceRoot, WorkspaceKind } from "./workspace.ts";
import { TaskBoundary, type TaskRunner } from "./steps-objective.ts";
import {
  prepareStepsWorkspace,
  startCheck,
  runTask,
  runStepsObjective,
  verifyTask,
} from "./steps-objective.ts";
import {
  RefreshResult,
  refreshAtClaim,
  refreshBeforeRelease,
} from "./base-refresh.ts";

const transport = { ...connector, proveSshIdentity: async () => {} };

const SECRET = "test_steps_key";
const PROVIDER_CALL_COUNT = 2;
const NO_PROVIDER_CALLS = 0;
const NO_PUSHES = 0;
const REPAIRED_TASK_CALLS = 3;
const ONE_JUDGEMENT = 1;
const MERGE_COMMIT_FIELDS = 3;
const MAIN_ADDITION = "added by main";
const RESOLVED = "resolved";
const LATE_MAIN_CHANGE = "late main change";
const DEADLINE_MS = 20000;
const TASK_VERIFIED = "task verified";
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
  turns?: number,
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
    priorRationale: null as string | null,
    provider,
    bare,
  };
}

test("objective pushes the evidenced head before release and retains its workspace", async (t) => {
  const h = await fixture(t, [], []);
  const order: string[] = [];
  h.run.clients.mission = {
    "evidence.submit": async (input: {
      body: { assets: { address: { commit: string } }[] };
    }) => {
      order.push("evidence");
      const remote = (
        await simpleGit(h.bare).revparse([`refs/heads/${h.nodeBranch}`])
      ).trim();
      assert.equal(input.body.assets[0]!.address.commit, remote);
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async () => {
      order.push("release");
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsObjective(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(order, ["evidence", "release"]);
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  assert.ok(existsSync(h.directory));
});

test("objective checkpoints budget-ended work and refuses release after a failed push", async (t) => {
  const current = task("partial", "false");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "notes", content: "partial" }),
        { stopReason: "toolUse" },
      ),
    ],
    1,
  );
  let released = false;
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: { further_work: boolean } }) => {
      released = input.body.further_work;
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsObjective(h), {
    kind: "released",
    furtherWork: true,
  });
  assert.ok(released);
  const log = await simpleGit(h.bare).raw([
    "log",
    "-1",
    "--format=%s",
    `refs/heads/${h.nodeBranch}`,
  ]);
  assert.match(log, /checkpoint of task/);
  const other = await fixture(t, [], []);
  other.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      throw new Error("push failed");
    },
  };
  await assert.rejects(runStepsObjective(other));
  assert.ok(existsSync(other.directory));
});

test("start check judges passing tasks in order and discards verification changes", async (t) => {
  const tasks = [
    task("failed", "touch dirty; false"),
    task("met", "true"),
    task("unmet", "true"),
  ];
  const h = await fixture(t, tasks, [
    fauxAssistantMessage(
      'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
    ),
    fauxAssistantMessage(
      'kanthord-judgement: {"criterion_met":false,"rationale":"unmet"}',
    ),
  ]);
  assert.deepEqual(
    (await startCheck(h)).pending.map(({ task, instruction }) => [
      task.id,
      instruction,
    ]),
    [
      [tasks[0]!.id, null],
      [tasks[2]!.id, null],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(h.provider.calls[0]),
    /Previous judgement/,
  );
  assert.equal(h.provider.calls.length, PROVIDER_CALL_COUNT);
  assert.equal(existsSync(join(h.directory, "dirty")), false);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(tasks[1]!.id));
  assert.ok(JSON.stringify(h.provider.calls[1]).includes(tasks[2]!.id));
  h.input.workspaces.release(
    h.input.workspaces.objectiveKey(h.input.claim.node_id),
    WorkspaceKind.Objective,
  );
});

test("task work commits revisions and cleans verification writes before judgement", async (t) => {
  const current = task("work", "touch transient; grep -q good file");
  const write = (content: string) =>
    fauxAssistantMessage(fauxToolCall("write", { path: "file", content }), {
      stopReason: "toolUse",
    });
  const h = await fixture(
    t,
    [current],
    [
      write("bad"),
      fauxAssistantMessage("first"),
      write("good"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  const events = t.mock.method(h.run, "log");
  assert.deepEqual(await runTask(h, current), { kind: "complete" });
  assert.deepEqual(
    events.mock.calls.map((call) => call.arguments[0]),
    [
      "task started",
      "task committed",
      "task verified",
      "task committed",
      "task verified",
      "task judged",
    ],
  );
  const verified = events.mock.calls
    .filter((call) => call.arguments[0] === TASK_VERIFIED)
    .map((call) => call.arguments[1].passed);
  assert.deepEqual(verified, [false, true]);
  assert.equal(
    JSON.stringify(events.mock.calls.map((call) => call.arguments[1])).includes(
      "good",
    ),
    false,
  );
  const log = await simpleGit(h.directory).log();
  const COMMITS = 3;
  assert.equal(log.total, COMMITS);
  assert.equal(log.all[0]!.message, log.all[1]!.message);
  assert.ok(log.all[0]!.message.includes(current.id));
  assert.equal(existsSync(join(h.directory, "transient")), false);
  h.input.workspaces.release(
    h.input.workspaces.objectiveKey(h.input.claim.node_id),
    WorkspaceKind.Objective,
  );
});

test("turn exhaustion during task work leaves an uncommitted checkpoint boundary", async (t) => {
  const current = task("work", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "notes", content: "partial" }),
        { stopReason: "toolUse" },
      ),
    ],
    1,
  );
  const before = await simpleGit(h.directory).revparse(["HEAD"]);
  assert.deepEqual(await runTask(h, current), {
    kind: "budget_end",
    boundary: "in_progress",
  });
  assert.equal(await simpleGit(h.directory).revparse(["HEAD"]), before);
  assert.ok(existsSync(join(h.directory, "notes")));
  h.input.workspaces.release(
    h.input.workspaces.objectiveKey(h.input.claim.node_id),
    WorkspaceKind.Objective,
  );
});

test("B1 retains a failed-run boundary when the budget expires between iterations", async (t) => {
  const current = task("failed", "false");
  const h = await fixture(t, [current], [fauxAssistantMessage("work")]);
  let checks = 0;
  const EXPIRE_AT = 4;
  h.agent.prompt = async () => {};
  h.agent.budget.exhausted = () => ++checks >= EXPIRE_AT;
  assert.deepEqual(await runTask(h, current), {
    kind: "budget_end",
    boundary: "run_failed",
  });
  h.agent.budget.exhausted = () => true;
  assert.deepEqual(await runTask(h, current, TaskBoundary.RunFailed), {
    kind: "budget_end",
    boundary: "run_failed",
  });
});

test("B1 start-check timeout keeps failed disposition and cleanup runs after the wall deadline", async (t) => {
  const current = task("timeout", "touch transient; sleep 30");
  const h = await fixture(t, [current], []);
  let deadline = Date.now() + 10000;
  h.agent.budget.wallDeadline = () => {
    deadline = Date.now() + 30;
    return deadline;
  };
  h.agent.budget.exhausted = () => Date.now() >= deadline;
  const checked = await startCheck(h);
  assert.equal(checked.budgetEnd?.boundary, TaskBoundary.RunFailed);
  assert.equal(existsSync(join(h.directory, "transient")), false);
  assert.ok(Date.now() >= deadline && Date.now() < h.input.claim.expired_at);
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  const verification = await verifyTask(h, current);
  assert.equal(verification.results[0]!.timed_out, true);
});

test("S1 budget-ended task verification releases the evidenced head without further work", async (t) => {
  const current = task("failed-budget", "false");
  const h = await fixture(t, [current], []);
  h.agent.budget.exhausted = () => true;
  let evidenced = false;
  let released = false;
  h.run.clients.mission = {
    "evidence.submit": async () => {
      evidenced = true;
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: { further_work: boolean } }) => {
      assert.ok(evidenced);
      assert.equal(input.body.further_work, false);
      released = true;
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsObjective(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.ok(released);
  const timed = await fixture(
    t,
    [task("timed", "touch transient; sleep 30")],
    [fauxAssistantMessage("work")],
  );
  let deadline = Date.now() + 60000;
  timed.agent.budget.wallDeadline = () => {
    deadline = Date.now() + 30;
    return deadline;
  };
  timed.agent.budget.exhausted = () => Date.now() >= deadline;
  assert.deepEqual(await runTask(timed, timed.revision.tasks![0]!), {
    kind: "budget_end",
    boundary: "run_failed",
  });
  assert.equal(existsSync(join(timed.directory, "transient")), false);
});

test("criterion-negative judgement revises work and a budget-ended judgement keeps passing disposition", async (t) => {
  const current = task("criterion", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":false,"rationale":"revise"}',
      ),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "revision", content: "fixed" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("revised"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual(await runTask(h, current), { kind: "complete" });
  assert.ok(existsSync(join(h.directory, "revision")));
  const other = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  const instruct = other.agent.instruct.bind(other.agent);
  other.agent.instruct = async (...args) => {
    await instruct(...args);
    other.agent.budget.exhausted = () => true;
  };
  assert.deepEqual(await runTask(other, current), {
    kind: "budget_end",
    boundary: "run_passed",
  });
});

const STOP_REASONS = [
  EndReason.OperationFailed,
  EndReason.JudgementInvalid,
  EndReason.ReportAbsent,
  EndReason.ActionUnsettled,
  EndReason.AssessmentAbsent,
];
const STOP_CODE = "test.operation.failed";
const PARTIAL_WORK = "partial";

function stoppingRunner(reason: EndReason): TaskRunner {
  return async (state) => {
    writeFileSync(join(state.directory, PARTIAL_WORK), PARTIAL_WORK);
    return state.run.stop(reason, STOP_CODE);
  };
}

function recordReleases(h: Awaited<ReturnType<typeof fixture>>) {
  const bodies: unknown[] = [];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: unknown }) => {
      bodies.push(input.body);
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  return bodies;
}

test("a stop with each reason checkpoints, pushes and releases with the stop", async (t) => {
  for (const reason of STOP_REASONS) {
    const h = await fixture(t, [task("stopped", "false")], []);
    const bodies = recordReleases(h);
    const stop = { reason, code: STOP_CODE };
    assert.deepEqual(
      await executionBoundary(h.run, () =>
        runStepsObjective(h, stoppingRunner(reason)),
      ),
      { kind: "released", furtherWork: true, stop },
    );
    assert.deepEqual(bodies, [{ further_work: true, stop }]);
    const branch = `refs/heads/${h.nodeBranch}`;
    assert.match(
      await simpleGit(h.bare).raw(["log", "-1", "--format=%s", branch]),
      /checkpoint of task/,
    );
    assert.equal(
      await simpleGit(h.bare).raw(["show", `${branch}:${PARTIAL_WORK}`]),
      PARTIAL_WORK,
    );
  }
});

test("a failed push still releases with the stop and a failed release ends with no release", async (t) => {
  const pushed = await fixture(t, [task("stopped", "false")], []);
  pushed.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      throw new Error("push failed");
    },
  };
  const bodies = recordReleases(pushed);
  const stop = { reason: EndReason.OperationFailed, code: STOP_CODE };
  assert.deepEqual(
    await executionBoundary(pushed.run, () =>
      runStepsObjective(pushed, stoppingRunner(EndReason.OperationFailed)),
    ),
    { kind: "released", furtherWork: true, stop },
  );
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
  const refused = await fixture(t, [task("stopped", "false")], []);
  refused.run.clients.scheduler = {
    executionRelease: async () => {
      throw new Error("release failed");
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(
    await executionBoundary(refused.run, () =>
      runStepsObjective(refused, stoppingRunner(EndReason.OperationFailed)),
    ),
    { kind: "ended", ...stop },
  );
});

test("a revoked stop writes no checkpoint, pushes nothing and releases nothing", async (t) => {
  const h = await fixture(t, [task("stopped", "false")], []);
  const bodies = recordReleases(h);
  let pushes = 0;
  h.input.transport = {
    ...transport,
    pushNodeBranch: async () => {
      pushes++;
    },
  };
  assert.deepEqual(
    await executionBoundary(h.run, () =>
      runStepsObjective(h, stoppingRunner(EndReason.Revoked)),
    ),
    { kind: "ended", reason: EndReason.Revoked, code: STOP_CODE },
  );
  assert.deepEqual(bodies, []);
  assert.equal(pushes, NO_PUSHES);
  assert.equal(
    (await simpleGit(h.directory).status()).not_added.includes(PARTIAL_WORK),
    true,
  );
});

test("one invalid task judgement gets a repair turn and a valid second reply completes the task", async (t) => {
  const current = task("repaired", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage(
        'канthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual(await runTask(h, current), { kind: "complete" });
  assert.ok(
    JSON.stringify(h.provider.calls.at(-1)).includes(
      repairInstruction(JUDGEMENT_MARKER),
    ),
  );
});

test("two invalid task judgements stop the execution with judgement_invalid", async (t) => {
  const current = task("invalid", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage("still no judgement"),
    ],
  );
  await assert.rejects(runTask(h, current), {
    reason: EndReason.JudgementInvalid,
  });
  assert.equal(h.provider.calls.length, REPAIRED_TASK_CALLS);
});

test("the start check repairs one invalid judgement and stops on two", async (t) => {
  const repaired = await fixture(
    t,
    [task("met", "true")],
    [
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual((await startCheck(repaired)).pending, []);
  assert.equal(repaired.provider.calls.length, PROVIDER_CALL_COUNT);
  const invalid = await fixture(
    t,
    [task("met", "true")],
    [
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage("still no judgement"),
    ],
  );
  await assert.rejects(startCheck(invalid), {
    reason: EndReason.JudgementInvalid,
  });
});

test("a repair turn that ends the budget keeps the passing boundary and releases a checkpoint with no stop", async (t) => {
  const current = task("repair", "true");
  const ended = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage("no judgement"),
      fauxAssistantMessage("partial"),
    ],
  );
  const endOnRepair = (h: Awaited<ReturnType<typeof fixture>>) => {
    const instruct = h.agent.instruct.bind(h.agent);
    h.agent.instruct = async (work, instruction) => {
      await instruct(work, instruction);
      if (instruction !== repairInstruction(JUDGEMENT_MARKER)) return;
      writeFileSync(join(h.directory, PARTIAL_WORK), PARTIAL_WORK);
      h.agent.budget.exhausted = () => true;
    };
  };
  endOnRepair(ended);
  assert.deepEqual(await runTask(ended, current), {
    kind: "budget_end",
    boundary: "run_passed",
  });
  const h = await fixture(
    t,
    [current],
    [fauxAssistantMessage("no judgement"), fauxAssistantMessage("partial")],
  );
  endOnRepair(h);
  const bodies = recordReleases(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsObjective(h)), {
    kind: "released",
    furtherWork: true,
  });
  assert.deepEqual(bodies, [{ further_work: true, progress: false }]);
  const branch = `refs/heads/${h.nodeBranch}`;
  assert.match(
    await simpleGit(h.bare).raw(["log", "-1", "--format=%s", branch]),
    /checkpoint of task/,
  );
  assert.equal(
    await simpleGit(h.bare).raw(["show", `${branch}:${PARTIAL_WORK}`]),
    PARTIAL_WORK,
  );
});

test("the start check skips the judgement of a task judged met at the current head", async (t) => {
  const current = task("judged", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  assert.deepEqual((await startCheck(h)).pending, []);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  h.priorRationale = `Unmet:\n- ${current.id}: still open`;
  const reworked = await startCheck(h);
  assert.deepEqual(
    reworked.pending.map((pending) => pending.task.id),
    [current.id],
  );
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
});

test("the start check revises a task that the prior rationale names without a judgement", async (t) => {
  const named = task("named", "true");
  const other = task("other", "true");
  const h = await fixture(
    t,
    [named, other],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  const rationale = `Two gaps\nUnmet:\n- ${named.id}: no route check`;
  h.priorRationale = rationale;
  const checked = await startCheck(h);
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(other.id));
  assert.deepEqual(checked.pending, [
    {
      task: named,
      boundary: "run_passed",
      instruction: criterionRevisionInstruction(rationale),
    },
  ]);
});

test("the start check judges a task against the prior rationale and revises it with that rationale", async (t) => {
  const rationale = "The edge case stays unhandled";
  const current = task("rework", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":false,"rationale":"unmet"}',
      ),
      fauxAssistantMessage("revised"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  h.priorRationale = rationale;
  const checked = await startCheck(h);
  assert.ok(
    JSON.stringify(h.provider.calls[0]).includes(
      `Previous judgement: ${rationale}. Judge whether the task criterion is met now.`,
    ),
  );
  const revision = criterionRevisionInstruction(rationale);
  assert.deepEqual(checked.pending, [
    { task: current, boundary: "run_passed", instruction: revision },
  ]);
  const [pending] = checked.pending;
  assert.deepEqual(
    await runTask(h, current, pending!.boundary, pending!.instruction),
    { kind: "complete" },
  );
  assert.ok(JSON.stringify(h.provider.calls[1]).includes(revision));
});

async function advanceBase(
  h: { bare: string },
  t: TestContext,
  content: string,
  path = "file",
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(h.bare, clone, ["--branch", "main"]);
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(clone, path), content);
  await git.add(path);
  await git.commit(`base change of ${path}`);
  await git.push("origin", "main");
}

async function commitOnNode(directory: string, content: string) {
  writeFileSync(join(directory, "file"), content);
  await simpleGit(directory).add("file");
  await simpleGit(directory).commit("node change");
}

const NODE_CONTENT = {
  name: "node",
  requirement: "node",
  criterion: "node",
  verifications: ["true"],
  bindings: [],
};

test("the claim refresh merges a moved base branch without a conflict", async (t) => {
  const h = await fixture(t, [], []);
  await advanceBase(h, t, MAIN_ADDITION, "other");
  await h.input.transport.fetchBase(
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.directory, "other"), "utf8"), MAIN_ADDITION);
  const parents = await simpleGit(h.directory).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    "HEAD",
  ]);
  assert.equal(parents.trim().split(" ").length, MERGE_COMMIT_FIELDS);
  assert.equal(await refreshAtClaim(h), RefreshResult.Current);
});

test("the claim refresh lets the agent resolve a merge conflict and commits the merge", async (t) => {
  const h = await fixture(
    t,
    [],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "file", content: RESOLVED }),
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("resolved"),
    ],
  );
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  await commitOnNode(h.directory, "node side");
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(readFileSync(join(h.directory, "file"), "utf8"), RESOLVED);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes("conflicts"));
  assert.equal((await simpleGit(h.directory).status()).isClean(), true);
});

test("the claim refresh aborts the merge and stops when a conflict marker remains", async (t) => {
  const h = await fixture(
    t,
    [],
    [fauxAssistantMessage("I could not resolve it")],
  );
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  await commitOnNode(h.directory, "node side");
  const before = await simpleGit(h.directory).revparse(["HEAD"]);
  await advanceBase(h, t, "main side");
  await h.input.transport.fetchBase(
    h.directory,
    "main",
    background,
    DEADLINE_MS,
  );
  await assert.rejects(refreshAtClaim(h), ExecutionStop);
  assert.equal(await simpleGit(h.directory).revparse(["HEAD"]), before);
  assert.equal((await simpleGit(h.directory).status()).isClean(), true);
});

test("the release refresh merges a clean base change only when every task still passes", async (t) => {
  const passing = await fixture(t, [task("pass", "true")], []);
  await advanceBase(passing, t, LATE_MAIN_CHANGE, "other");
  assert.equal(await refreshBeforeRelease(passing, async () => true), true);
  assert.equal(
    readFileSync(join(passing.directory, "other"), "utf8"),
    LATE_MAIN_CHANGE,
  );
  const failing = await fixture(t, [task("fail", "false")], []);
  const before = failing.head;
  await advanceBase(failing, t, LATE_MAIN_CHANGE, "other");
  assert.equal(await refreshBeforeRelease(failing, async () => false), false);
  assert.equal(failing.head, before);
  assert.equal(await simpleGit(failing.directory).revparse(["HEAD"]), before);
});

test("the release refresh refuses a conflicting base change and keeps the node head", async (t) => {
  const h = await fixture(t, [], []);
  await commitOnNode(h.directory, "node side");
  h.head = await simpleGit(h.directory).revparse(["HEAD"]);
  await advanceBase(h, t, "main side");
  assert.equal(await refreshBeforeRelease(h, async () => true), false);
  assert.equal(await simpleGit(h.directory).revparse(["HEAD"]), h.head);
  assert.equal((await simpleGit(h.directory).status()).isClean(), true);
});
