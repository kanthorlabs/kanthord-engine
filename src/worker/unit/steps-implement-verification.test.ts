import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { EndReason, type ExecutionEnd } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import { VERIFICATION_INFRASTRUCTURE_FAILED } from "./verification.ts";
import {
  runStepsImplement,
  runTask,
  startCheck,
  TaskResultKind,
} from "./steps-implement.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  NO_PROVIDER_CALLS,
  recordReleases,
  task,
} from "./test-support.ts";

const SIGNAL_KILL = "sh -c 'kill -9 $$'";
const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
const ONE_JUDGEMENT = 1;
const ONE_TURN = 1;
const JUDGEMENT_AND_VERDICT_TURN = 3;
const WALL_DEADLINE_MS = 300;
const MET = 'kanthord-judgement: {"criterion_met":true,"rationale":"met"}';

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

test("a persistent kill in a task verification stops with the infrastructure code and sends no turn", async (t) => {
  for (const command of [SIGNAL_KILL, EXIT_KILL]) {
    const h = await fixture(
      t,
      [task("killed", command)],
      [fauxAssistantMessage("work"), fauxAssistantMessage("revised")],
    );
    const bodies = recordReleases(h);
    const end = await executionBoundary(h.run, () => runStepsImplement(h));
    infrastructureEnd(end, bodies, command);
    assert.equal(h.provider.calls.length, NO_PROVIDER_CALLS);
  }
});

test("a persistent kill in a node verification of the verdict unit stops with the infrastructure code", async (t) => {
  const h = await fixture(
    t,
    [task("passing", "true")],
    [
      fauxAssistantMessage(MET),
      fauxAssistantMessage(
        fauxToolCall("write", { path: "verdict", content: "verdict" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("addressed"),
      fauxAssistantMessage("never"),
    ],
  );
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
  assert.equal(h.provider.calls.length, JUDGEMENT_AND_VERDICT_TURN);
});

test("a kill on the first run and a pass on the rerun passes the task verification", async (t) => {
  const marker = join(temporary(t), "killed");
  const current = task(
    "rerun",
    `test -f ${marker} || { touch ${marker}; kill -9 $$; }`,
  );
  const h = await fixture(t, [current], [fauxAssistantMessage(MET)]);
  const checked = await startCheck(h);
  assert.deepEqual(checked, { pending: [], node: null, budgetEnd: null });
  assert.equal(h.provider.calls.length, ONE_JUDGEMENT);
});

test("exit 127 in a task verification is a code failure that sends a work turn", async (t) => {
  const current = task("absent", "command-absent-x");
  const h = await fixture(t, [current], []);
  const checked = await startCheck(h);
  assert.deepEqual(checked, {
    pending: [{ task: current, instruction: null }],
    node: null,
    budgetEnd: null,
  });
});

test("a kill at the wall deadline during a verification is a budget end and not a stop", async (t) => {
  const current = task("slow", "sleep 30");
  const checked = await fixture(t, [current], []);
  const checkDeadline = Date.now() + WALL_DEADLINE_MS;
  checked.agent.budget.wallDeadline = () => checkDeadline;
  assert.deepEqual(await startCheck(checked), {
    pending: [],
    node: null,
    budgetEnd: { task: current },
  });
  assert.equal(checked.agent.budget.exhausted(), true);
  const worked = await fixture(t, [current], [fauxAssistantMessage("work")]);
  const workDeadline = Date.now() + WALL_DEADLINE_MS;
  worked.agent.budget.wallDeadline = () => workDeadline;
  assert.deepEqual(await runTask(worked, current), {
    kind: TaskResultKind.BudgetEnd,
  });
  assert.equal(worked.provider.calls.length, ONE_TURN);
});
