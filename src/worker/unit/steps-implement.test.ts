import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { DeadlineExceeded } from "../../kernel/context.ts";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import { fauxAssistantMessage, fauxToolCall } from "./test-support.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import {
  criterionRevisionInstruction,
  JUDGEMENT_MARKER,
  repairInstruction,
  taskJudgementInstruction,
} from "./judgement.ts";
import type { MethodClients } from "./method-clients.ts";
import { CHECKOUTS_DIRECTORY, WorkspaceKind } from "./workspace.ts";
import { judgedAt } from "./judged-tasks.ts";
import { TaskBoundary } from "./steps-implement.ts";
import {
  startCheck,
  runTask,
  runStepsImplement,
  verifyTask,
} from "./steps-implement.ts";
import { SHIPPED_TEMPLATES } from "../../agent/prompt-templates.ts";
import { BudgetLimit, ProviderFailure } from "../../scheduler/contract.ts";
import {
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordReleases,
  STEPS_KEY,
  task,
} from "./test-support.ts";

const REPAIRED_TASK_CALLS = 3;
const TASK_VERIFIED = "task verified";
const PARTIAL_WORK = "partial";

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
  const log = await simpleGit(h.root).log();
  const COMMITS = 3;
  assert.equal(log.total, COMMITS);
  assert.equal(log.all[0]!.message, log.all[1]!.message);
  assert.ok(log.all[0]!.message.includes(current.id));
  assert.equal(existsSync(join(h.root, "transient")), false);
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
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
  const before = await simpleGit(h.root).revparse(["HEAD"]);
  assert.deepEqual(await runTask(h, current), {
    kind: "budget_end",
    boundary: "in_progress",
  });
  assert.equal(await simpleGit(h.root).revparse(["HEAD"]), before);
  assert.ok(existsSync(join(h.root, "notes")));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
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
  assert.equal(existsSync(join(h.root, "transient")), false);
  assert.ok(Date.now() >= deadline && Date.now() < h.input.claim.expired_at);
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  const verification = await verifyTask(h, current);
  assert.equal(verification.results[0]!.timed_out, true);
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
  assert.ok(existsSync(join(h.root, "revision")));
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

test("a judgement that its agent deadline cuts ends as a budget end after the passing run", async (t) => {
  const current = task("deadline", "true");
  const h = await fixture(t, [current], [fauxAssistantMessage("work")]);
  const judgement = taskJudgementInstruction(SHIPPED_TEMPLATES, current, null);
  const instructions: string[] = [];
  h.agent.instruct = async (_work, instruction) => {
    instructions.push(instruction);
    h.agent.budget
      .agentContext(h.run.operationContext)
      .cancel(new DeadlineExceeded());
  };
  assert.deepEqual(await runTask(h, current), {
    kind: "budget_end",
    boundary: "run_passed",
  });
  assert.deepEqual(instructions, [judgement]);
  assert.equal(h.agent.budget.limit(), BudgetLimit.WallTime);
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
      repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER),
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
      if (
        instruction !== repairInstruction(SHIPPED_TEMPLATES, JUDGEMENT_MARKER)
      )
        return;
      writeFileSync(join(h.root, PARTIAL_WORK), PARTIAL_WORK);
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
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: true,
    stop: { reason: "budget_end", code: "wall_time" },
  });
  assert.deepEqual(bodies, [
    { further_work: true, stop: { reason: "budget_end", code: "wall_time" } },
  ]);
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
  const revision = criterionRevisionInstruction(SHIPPED_TEMPLATES, rationale);
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

const VERIFIED_BEFORE_NO_PROGRESS = 2;

async function stopOf(work: Promise<unknown>): Promise<ExecutionStop> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof ExecutionStop);
    return error;
  }
  return assert.fail("The task loop did not stop.");
}

test("a revision that changes nothing twice stops the task with no_progress", async (t) => {
  const current = task("stuck", "false");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage("nothing again"),
      fauxAssistantMessage("still nothing"),
    ],
  );
  const events = t.mock.method(h.run, "log");
  const stopped = await stopOf(runTask(h, current));
  assert.equal(stopped.reason, EndReason.NoProgress);
  assert.equal(stopped.code, null);
  assert.deepEqual(
    events.mock.calls
      .map((call) => call.arguments[0])
      .filter((msg) => msg === TASK_VERIFIED).length,
    VERIFIED_BEFORE_NO_PROGRESS,
  );
});

test("a revoked claim stops the task loop before the next cycle", async (t) => {
  const current = task("revoked", "false");
  const h = await fixture(t, [current], [fauxAssistantMessage("never")]);
  h.run.clients.scheduler = {
    claimGet: async () => ({
      type: "completed",
      status: 200,
      data: { claim_state: "finished" },
    }),
  } as unknown as MethodClients["scheduler"];
  const events = t.mock.method(h.run, "log");
  const stopped = await stopOf(runTask(h, current));
  assert.equal(stopped.reason, EndReason.Revoked);
  assert.deepEqual(
    events.mock.calls.map((call) => call.arguments[0]),
    ["task started"],
  );
});

test("a provider error reply stops the task with provider_failed and its code", async (t) => {
  const current = task("provider", "false");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "403 Forbidden: only agentic harnesses",
      }),
    ],
  );
  const stopped = await stopOf(runTask(h, current));
  assert.equal(stopped.reason, EndReason.ProviderFailed);
  assert.equal(stopped.code, ProviderFailure.Unauthorized);
});

test("a provider error reply carries its cause text with secrets removed and cut to 300 characters", async (t) => {
  const current = task("provider", "false");
  const cause = `OAuth auth derivation failed for anthropic: Cannot find module 'x' key ${STEPS_KEY} Bearer opaque`;
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: `${cause} ${"word ".repeat(100)}`,
      }),
    ],
  );
  const stopped = await stopOf(runTask(h, current));
  assert.equal(stopped.reason, EndReason.ProviderFailed);
  assert.equal(stopped.code, ProviderFailure.Unavailable);
  assert.ok(
    stopped.detail?.startsWith(
      "OAuth auth derivation failed for anthropic: Cannot find module 'x' key [redacted] [redacted]",
    ),
  );
  assert.equal(stopped.detail?.includes(STEPS_KEY), false);
  assert.equal(stopped.detail?.length, REASON_MAX_LENGTH);
});

test("an implement node with no task commits its change with the node identity in the message before it releases", async (t) => {
  const h = await fixture(
    t,
    [],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "node-file", content: "node" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
  );
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: ["test -f node-file"] },
  };
  const nodeId = h.input.claim.node_id;
  const order: string[] = [];
  h.run.clients.mission = {
    "evidence.submit": async () => {
      order.push("evidence");
      return { type: "completed", status: 200, data: { evidence: {} } };
    },
  } as unknown as MethodClients["mission"];
  h.run.clients.scheduler = {
    executionRelease: async (input: { body: { further_work: boolean } }) => {
      order.push(`release:${input.body.further_work}`);
      return { type: "completed", status: 200, data: {} };
    },
  } as unknown as MethodClients["scheduler"];
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(order, ["evidence", "release:false"]);
  const log = await simpleGit(h.root).log();
  assert.ok(log.latest!.message.includes(nodeId));
  assert.ok(existsSync(join(h.root, "node-file")));
});

const TWO_BINDINGS = ["api", "web"];

test("two bindings commit only the checkout with a change", async (t) => {
  const current = task("api-change", "test -f api/added");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "api/added", content: "added" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
      fauxAssistantMessage(
        'kanthord-judgement: {"criterion_met":true,"rationale":"met"}',
      ),
    ],
    undefined,
    TWO_BINDINGS,
  );
  const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
  assert.equal(h.root, join(key, CHECKOUTS_DIRECTORY));
  const [api, web] = h.checkouts;
  assert.ok(api && web);
  const apiBefore = api.head;
  const webBefore = web.head;
  assert.deepEqual(await runTask(h, current), { kind: "complete" });
  assert.notEqual(api.head, apiBefore);
  assert.equal(await simpleGit(api.directory).revparse(["HEAD"]), api.head);
  assert.ok(
    (await simpleGit(api.directory).log()).latest!.message.includes(current.id),
  );
  assert.equal(web.head, webBefore);
  assert.equal(await simpleGit(web.directory).revparse(["HEAD"]), webBefore);
  assert.equal(
    judgedAt(key, {
      attempt: h.input.claim.attempt,
      revision: h.input.claim.pinned_revision,
      taskId: current.id,
    }),
    `api=${api.head},web=${web.head}`,
  );
  h.input.workspaces.release(key, WorkspaceKind.Node);
});

test("a revision that changes no checkout counts as no progress", async (t) => {
  const current = task("stuck", "false");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage("nothing again"),
      fauxAssistantMessage("still nothing"),
    ],
    undefined,
    TWO_BINDINGS,
  );
  const heads = h.checkouts.map((checkout) => checkout.head);
  const stopped = await stopOf(runTask(h, current));
  assert.equal(stopped.reason, EndReason.NoProgress);
  assert.deepEqual(
    h.checkouts.map((checkout) => checkout.head),
    heads,
  );
});

test("a verification at the agent root of two bindings leaves only the checkouts and the scratch directory", async (t) => {
  const current = task(
    "root-writes",
    "touch stray && mkdir -p stray-dir .kanthord-scratch && touch .kanthord-scratch/probe api/transient",
  );
  const h = await fixture(t, [current], [], undefined, TWO_BINDINGS);
  await verifyTask(h, current);
  assert.deepEqual(readdirSync(h.root).sort(), [
    ".kanthord-scratch",
    ...TWO_BINDINGS,
  ]);
  assert.ok(existsSync(join(h.root, ".kanthord-scratch", "probe")));
  assert.equal(existsSync(join(h.root, "api", "transient")), false);
  for (const checkout of h.checkouts)
    assert.ok(existsSync(join(checkout.directory, ".git")));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
});
