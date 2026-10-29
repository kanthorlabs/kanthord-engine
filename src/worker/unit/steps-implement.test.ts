import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { contentText } from "@earendil-works/pi-ai";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  listedVerificationSpans,
  recordSpans,
  spanEnds,
} from "./test-support.ts";
import { SpanOperation } from "./telemetry.ts";
import { VerificationContext } from "./method-telemetry.ts";
import { CauseCategory, unattributed } from "../../kernel/cause.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { CHECKOUTS_DIRECTORY, WorkspaceKind } from "./workspace.ts";
import { DONE_TRAILER, doneRecordOf } from "./done-record.ts";
import {
  runStepsImplement,
  runTask,
  startCheck,
  TaskResultKind,
  taskWork,
  verifyTaskRun,
} from "./steps-implement.ts";
import { nodeWork } from "./base-refresh.ts";
import { nodeUnitOf } from "./release-gate.ts";
import { ProviderFailure } from "../../scheduler/contract.ts";
import { NoProgressRule } from "./progress-rule.ts";
import {
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordDone,
  recordReleases,
  STEPS_KEY,
  task,
} from "./test-support.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import type { Revision } from "../../mission/contract.ts";
import { executionBoundary } from "./native-method.ts";

const TASK_VERIFIED = "task verified";
const REVISION_COUNT_ATTRIBUTE = "kanthord.task.revision_count";
const WALL_DEADLINE_MS = 5000;

function writeFile(content: string) {
  return fauxAssistantMessage(
    fauxToolCall("write", { path: "file", content }),
    { stopReason: "toolUse" },
  );
}

function acceptEvidence(h: Awaited<ReturnType<typeof fixture>>): void {
  h.run.clients.mission = {
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
}

async function revisionCountsOf(
  t: Parameters<typeof fixture>[0],
  script: Parameters<typeof fixture>[2],
) {
  const h = await fixture(t, [task("work", "grep -q good file")], script);
  const records = recordSpans(h);
  acceptEvidence(h);
  recordReleases(h);
  await runStepsImplement(h);
  return spanEnds(records, SpanOperation.Task).map(
    (end) => end.attributes?.[REVISION_COUNT_ATTRIBUTE],
  );
}

test("a task that passes on its first send ends with the revision count 0", async (t) => {
  const counts = await revisionCountsOf(t, [
    writeFile("good"),
    fauxAssistantMessage("first"),
  ]);
  assert.deepEqual(counts, [0]);
});

test("a task with two revision turns ends with the revision count 2", async (t) => {
  const counts = await revisionCountsOf(t, [
    writeFile("bad"),
    fauxAssistantMessage("first"),
    writeFile("worse"),
    fauxAssistantMessage("second"),
    writeFile("good"),
    fauxAssistantMessage("third"),
  ]);
  assert.deepEqual(counts, [2]);
});

test("a budget end after a timed-out verification releases with the suspects environment, plan and model", async (t) => {
  const h = await fixture(
    t,
    [task("slow", "sleep 30")],
    [fauxAssistantMessage("work")],
  );
  const deadline = Date.now() + WALL_DEADLINE_MS;
  h.agent.budget.wallDeadline = () => deadline;
  const bodies = recordReleases(h) as {
    stop: { cause: unknown };
  }[];
  await runStepsImplement(h);
  assert.deepEqual(
    bodies.map((body) => body.stop.cause),
    [
      unattributed([
        CauseCategory.Environment,
        CauseCategory.Plan,
        CauseCategory.Model,
      ]),
    ],
  );
});

test("a node instruction names criterion-revision, then task-revision for its revision", async (t) => {
  const done = task("done", "true");
  const h = await fixture(
    t,
    [done],
    [
      fauxAssistantMessage("nothing"),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "revised", content: "good" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("revised"),
    ],
  );
  h.revision = {
    tasks: [done],
    content: {
      name: "node",
      requirement: "node",
      criterion: "node",
      verifications: ["test -f revised"],
      bindings: [],
    },
  } as unknown as Revision;
  await recordDone(h, done);
  h.verdict = { text: "Rework the node.", judged: [] };
  const instruct = t.mock.method(h.agent, "instruct");
  recordReleases(h);
  await executionBoundary(h.run, () => runStepsImplement(h));
  assert.deepEqual(
    instruct.mock.calls.map((call) => call.arguments[2]),
    [PromptTemplate.CriterionRevision, PromptTemplate.TaskRevision],
  );
});

test("task work commits revisions, cleans verification writes and records the pass", async (t) => {
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
    ],
  );
  const events = t.mock.method(h.run, "log");
  assert.deepEqual(await runTask(h, current), {
    kind: "complete",
    recorded: true,
  });
  assert.deepEqual(
    events.mock.calls.map((call) => call.arguments[0]),
    [
      "task started",
      "task committed",
      "task verified",
      "task committed",
      "task verified",
      "done recorded",
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
  assert.equal(log.all[0]!.body.split("\n")[0], current.id);
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
  assert.deepEqual(await runTask(h, current), { kind: "budget_end" });
  assert.equal(await simpleGit(h.root).revparse(["HEAD"]), before);
  assert.ok(existsSync(join(h.root, "notes")));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
});

test("B1 ends the task as a budget end when the budget expires between iterations", async (t) => {
  const current = task("failed", "false");
  const h = await fixture(t, [current], [fauxAssistantMessage("work")]);
  let checks = 0;
  const EXPIRE_AT = 4;
  h.agent.prompt = async () => {};
  h.agent.budget.exhausted = () => ++checks >= EXPIRE_AT;
  assert.deepEqual(await runTask(h, current), { kind: "budget_end" });
  h.agent.budget.exhausted = () => true;
  assert.deepEqual(await runTask(h, current), { kind: "budget_end" });
});

test("the start check runs no verification, and a verification timeout cleans its writes", async (t) => {
  const current = task("timeout", "touch transient; sleep 30");
  const h = await fixture(t, [current], []);
  const checked = await startCheck(h);
  assert.deepEqual(
    checked.pending.map(({ task }) => task.id),
    [current.id],
  );
  assert.equal(checked.budgetEnd, null);
  assert.equal(existsSync(join(h.root, "transient")), false);
  assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  let deadline = Date.now() + 10000;
  h.agent.budget.wallDeadline = () => {
    deadline = Date.now() + 30;
    return deadline;
  };
  h.agent.budget.exhausted = () => Date.now() >= deadline;
  const { verification } = await verifyTaskRun(h, current);
  assert.equal(verification.results[0]!.timed_out, true);
  assert.equal(existsSync(join(h.root, "transient")), false);
  assert.ok(Date.now() >= deadline && Date.now() < h.input.claim.expired_at);
});

const VERIFIED_BEFORE_NO_PROGRESS = 2;
const NO_PROGRESS_LIMIT = 2;
const FAILED_EXIT_CODE = 1;
const ONE_COMMAND = 1;

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
  assert.deepEqual(JSON.parse(stopped.detail!), {
    rule: NoProgressRule.UnchangedRevision,
    count: NO_PROGRESS_LIMIT,
    limit: NO_PROGRESS_LIMIT,
    verification: {
      passed: false,
      ran: ONE_COMMAND,
      exit_code: FAILED_EXIT_CODE,
      timed_out: false,
    },
  });
  assert.deepEqual(
    events.mock.calls
      .map((call) => call.arguments[0])
      .filter((msg) => msg === TASK_VERIFIED).length,
    VERIFIED_BEFORE_NO_PROGRESS,
  );
});

test("a live failure runs again on the next turn with an unchanged tree", async (t) => {
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
  const records = recordSpans(h);
  await stopOf(runTask(h, current));
  assert.deepEqual(
    listedVerificationSpans(records).map((span) => [span.context, span.index]),
    [
      [VerificationContext.Task, 0],
      [VerificationContext.Task, 0],
    ],
  );
});

test("a pass of an own command on an unchanged tree is reused by the next task", async (t) => {
  const first = task("first", "test -d .");
  const second = task("second", "test -d .");
  const h = await fixture(
    t,
    [first, second],
    [fauxAssistantMessage("nothing"), fauxAssistantMessage("nothing again")],
  );
  const records = recordSpans(h);
  assert.equal((await runTask(h, first)).kind, TaskResultKind.Complete);
  assert.equal((await runTask(h, second)).kind, TaskResultKind.Complete);
  assert.deepEqual(
    listedVerificationSpans(records).map((span) => [span.context, span.owner]),
    [[VerificationContext.Task, first.id]],
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
  assert.equal(log.latest!.body.split("\n")[0], nodeId);
  assert.ok(existsSync(join(h.root, "node-file")));
});

test("a task skips each node command in the live checkout and runs each own command", async (t) => {
  const current = task("work", "true");
  current.content.verifications = ["true", "test -d .", "true", "test -d ."];
  const h = await fixture(t, [current], []);
  const records = recordSpans(h);
  const { verification } = await verifyTaskRun(h, current);
  assert.deepEqual(
    verification.results.map((result) => result.command),
    ["test -d .", "test -d ."],
  );
  assert.deepEqual(
    listedVerificationSpans(records).map((span) => [span.context, span.index]),
    [
      [VerificationContext.Task, 0],
      [VerificationContext.Task, 1],
    ],
  );
  const node = await verifyTaskRun(
    h,
    nodeUnitOf(h.input.claim.node_id, h.revision),
  );
  assert.deepEqual(node.verification.results, []);
  assert.deepEqual(node.commands, []);
});

test("a node with no task runs no live verification, and the release gate runs each node verification once", async (t) => {
  const h = await fixture(
    t,
    [],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "node-file", content: "node" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("done"),
    ],
  );
  h.revision = {
    ...h.revision,
    content: {
      ...h.revision.content,
      verifications: ["test -f node-file", "true"],
    },
  };
  const records = recordSpans(h);
  acceptEvidence(h);
  recordReleases(h);
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  const spans = listedVerificationSpans(records);
  assert.deepEqual(
    spans.filter((span) => span.context === VerificationContext.Node),
    [],
  );
  assert.deepEqual(
    spans
      .filter((span) => span.context === VerificationContext.Release)
      .map((span) => span.index),
    [0, 1],
  );
});

const NODE_FRAME =
  "# Node node frame\n\n## Requirement\n\nnode rule\n\n## Criterion\n\nnode check\n\n" +
  "Do only the task below. The node part above is context.\n\n";
const NODE_RULE = "node rule";
const USER_ROLE = "user";
const SYSTEM_ROLE = "system";
const ONE_REVISION = 1;
const ONE_WORK_MESSAGE = 1;

test("every task work prompt and its revision turn carry the node frame in the user message", async (t) => {
  const revised = task("first", "test -f revised");
  const tasks = [revised, task("second", "true")];
  const h = await fixture(t, tasks, [
    fauxAssistantMessage("first"),
    fauxAssistantMessage(
      fauxToolCall("write", { path: "revised", content: "good" }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("revised"),
    fauxAssistantMessage("second"),
  ]);
  h.revision = {
    ...h.revision,
    content: {
      ...h.revision.content,
      name: "node frame",
      requirement: NODE_RULE,
      criterion: "node check",
    },
  };
  for (const current of tasks)
    assert.ok(
      taskWork(h, current).text.startsWith(
        `${NODE_FRAME}# Task ${current.content.name}\n\n## Requirement\n\n${current.content.requirement}\n`,
      ),
    );
  const instruct = t.mock.method(h.agent, "instruct");
  for (const current of tasks)
    assert.equal((await runTask(h, current)).kind, TaskResultKind.Complete);
  assert.equal(instruct.mock.callCount(), ONE_REVISION);
  assert.equal(
    instruct.mock.calls[0]?.arguments[2],
    PromptTemplate.TaskRevision,
  );
  const promptedTasks = [revised, revised, revised, tasks[1]!];
  assert.equal(h.provider.calls.length, promptedTasks.length);
  h.provider.calls.forEach((call, index) => {
    const work = taskWork(h, promptedTasks[index]!).text;
    assert.equal(
      call.messages.filter(
        (entry) =>
          entry.role === USER_ROLE && contentText(entry.content) === work,
      ).length,
      ONE_WORK_MESSAGE,
    );
    assert.ok(!(call.systemPrompt ?? "").includes(NODE_RULE));
    assert.ok(
      !call.messages.some(
        (entry) =>
          entry.role === SYSTEM_ROLE &&
          contentText(entry.content).includes(NODE_RULE),
      ),
    );
  });
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
});

test("the work prompt of a node unit holds no node frame", async (t) => {
  const h = await fixture(t, [], []);
  const unit = nodeUnitOf(h.input.claim.node_id, h.revision);
  assert.deepEqual(taskWork(h, unit), nodeWork(h));
  assert.ok(taskWork(h, unit).text.startsWith("# implement\n\n## Requirement"));
  assert.ok(!taskWork(h, unit).text.slice(1).includes("# implement\n"));
  h.input.workspaces.release(
    h.input.workspaces.nodeKey(h.input.claim.node_id),
    WorkspaceKind.Node,
  );
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
  assert.deepEqual(await runTask(h, current), {
    kind: "complete",
    recorded: true,
  });
  assert.notEqual(api.head, apiBefore);
  assert.equal(await simpleGit(api.directory).revparse(["HEAD"]), api.head);
  assert.ok(
    (await simpleGit(api.directory).log()).latest!.body.includes(current.id),
  );
  assert.equal(web.head, webBefore);
  assert.equal(await simpleGit(web.directory).revparse(["HEAD"]), webBefore);
  assert.ok(
    (await simpleGit(api.directory).raw(["log", "-1", "--format=%B"])).includes(
      `${DONE_TRAILER}: ${doneRecordOf(current)}`,
    ),
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
  await verifyTaskRun(h, current);
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
