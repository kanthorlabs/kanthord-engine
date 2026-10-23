import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { existsSync } from "node:fs";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import { EndReason, type ExecutionEnd } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import { VERIFICATION_INFRASTRUCTURE_FAILED } from "./verification.ts";
import {
  runStepsImplement,
  runTask,
  TaskResultKind,
} from "./steps-implement.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  recordDone,
  recordReleases,
  task,
} from "./test-support.ts";

const SIGNAL_KILL = "sh -c 'kill -9 $$'";
const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
const ONE_TURN = 1;
const ONE_TOOL_TURN = 2;
const FOUR_TURNS = 4;
const SETUP_MARKER = "setup-ran";
const WALL_DEADLINE_MS = 300;

function infrastructureEnd(
  end: ExecutionEnd,
  bodies: unknown[],
  command: string,
) {
  assert.ok("stop" in end);
  const detail = end.stop?.detail ?? "";
  assert.ok(detail.includes(command));
  const stop = {
    reason: EndReason.OperationFailed,
    code: VERIFICATION_INFRASTRUCTURE_FAILED,
    detail,
  };
  assert.deepEqual(end, { kind: "released", furtherWork: true, stop });
  assert.deepEqual(bodies, [{ further_work: true, stop }]);
}

test("a persistent kill in a task verification stops with the infrastructure code and sends no revision turn", async (t) => {
  for (const command of [SIGNAL_KILL, EXIT_KILL]) {
    const h = await fixture(
      t,
      [task("killed", command)],
      [fauxAssistantMessage("work"), fauxAssistantMessage("revised")],
    );
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    infrastructureEnd(end, bodies, command);
    assert.equal(h.provider.calls.length, ONE_TURN);
  }
});

test("a persistent kill in a node verification of the verdict unit stops with the infrastructure code", async (t) => {
  const passing = task("passing", "true");
  const h = await fixture(
    t,
    [passing],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "verdict", content: "verdict" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("addressed"),
      fauxAssistantMessage("never"),
    ],
  );
  await recordDone(h, passing);
  h.verdict = {
    text: "The verdict names no task.",
    judged: [
      { binding_id: h.checkouts[0]!.binding_id, commit: h.checkouts[0]!.head },
    ],
  };
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: [SIGNAL_KILL] },
  };
  const bodies = recordReleases(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  infrastructureEnd(end, bodies, SIGNAL_KILL);
  assert.equal(h.provider.calls.length, ONE_TOOL_TURN);
});

test("a kill on the first run and a pass on the rerun passes the task verification", async (t) => {
  const marker = join(temporary(t), "killed");
  const current = task(
    "rerun",
    `test -f ${marker} || { touch ${marker}; kill -9 $$; }`,
  );
  const h = await fixture(t, [current], [fauxAssistantMessage("work")]);
  assert.deepEqual(await runTask(h, current), {
    kind: TaskResultKind.Complete,
    recorded: false,
  });
  assert.equal(h.provider.calls.length, ONE_TURN);
});

test("exit 127 on the node head and on the base head stops with environment_failed and sends no revision turn", async (t) => {
  const current = task("absent", "command-absent-x");
  const h = await fixture(
    t,
    [current],
    [fauxAssistantMessage("work"), fauxAssistantMessage("revised")],
  );
  await assert.rejects(runTask(h, current), {
    reason: EndReason.EnvironmentFailed,
    code: EnvironmentFailure.CommandAbsent,
  });
  assert.equal(h.provider.calls.length, ONE_TURN);
});

test("exit 127 on the node head that passes on the base head is a code failure that sends a revision turn", async (t) => {
  const current = task("absent", "test ! -e written || command-absent-x");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "written", content: "node" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("work"),
      fauxAssistantMessage("revised"),
      fauxAssistantMessage("revised again"),
    ],
  );
  await assert.rejects(runTask(h, current), { reason: EndReason.NoProgress });
  assert.equal(h.provider.calls.length, FOUR_TURNS);
});

test("a kill at the wall deadline during a verification is a budget end and not a stop", async (t) => {
  const current = task("slow", "sleep 30");
  const worked = await fixture(t, [current], [fauxAssistantMessage("work")]);
  const workDeadline = Date.now() + WALL_DEADLINE_MS;
  worked.agent.budget.wallDeadline = () => workDeadline;
  assert.deepEqual(await runTask(worked, current), {
    kind: TaskResultKind.BudgetEnd,
  });
  assert.equal(worked.provider.calls.length, ONE_TURN);
  assert.equal(worked.agent.budget.exhausted(), true);
});

test("a stored environment runs its setup in the node checkout before the first task verification", async (t) => {
  const current = task("setup", `test -e ${SETUP_MARKER}`);
  const h = await fixture(
    t,
    [current],
    [fauxAssistantMessage("work")],
    undefined,
    undefined,
    {
      source: EnvironmentSource.Stored,
      document: { postCreateCommand: `touch ${SETUP_MARKER}` },
    },
  );
  assert.equal(existsSync(join(h.checkouts[0]!.directory, SETUP_MARKER)), true);
  assert.deepEqual(await runTask(h, current), {
    kind: TaskResultKind.Complete,
    recorded: false,
  });
});

test("a setup failure on the base head stops the prepare with environment_failed", async (t) => {
  await assert.rejects(
    fixture(
      t,
      [task("setup", "true")],
      [fauxAssistantMessage("never")],
      undefined,
      undefined,
      {
        source: EnvironmentSource.Stored,
        document: { postCreateCommand: "exit 5" },
      },
    ),
    {
      reason: EndReason.EnvironmentFailed,
      code: EnvironmentFailure.SetupFailed,
    },
  );
});
