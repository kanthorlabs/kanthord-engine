import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { fauxAssistantMessage, fauxToolCall } from "./test-support.ts";
import { EndReason } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import type { TaskRunner } from "./steps-objective.ts";
import { runTask, runStepsObjective } from "./steps-objective.ts";
import { refreshBeforeRelease } from "./base-refresh.ts";
import {
  advanceBase,
  commitOnNode,
  objectiveFixture as fixture,
  NO_PROVIDER_CALLS,
  recordReleases,
  task,
  transport,
} from "./test-support.ts";

const NO_PUSHES = 0;
const LATE_MAIN_CHANGE = "late main change";

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
    stop: { reason: "budget_end", code: "turns" },
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
