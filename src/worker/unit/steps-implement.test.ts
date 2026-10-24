import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { REASON_MAX_LENGTH } from "../../kernel/probe.ts";
import { fauxAssistantMessage, fauxToolCall } from "./test-support.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import type { MethodClients } from "./method-clients.ts";
import { CHECKOUTS_DIRECTORY, WorkspaceKind } from "./workspace.ts";
import { DONE_TRAILER, doneRecordOf } from "./done-record.ts";
import {
  startCheck,
  runTask,
  runStepsImplement,
  verifyTaskRun,
} from "./steps-implement.ts";
import { ProviderFailure } from "../../scheduler/contract.ts";
import { NoProgressRule } from "./progress-rule.ts";
import {
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  STEPS_KEY,
  task,
} from "./test-support.ts";

const TASK_VERIFIED = "task verified";

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
    verification: { passed: false, exit_codes: [FAILED_EXIT_CODE] },
  });
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
