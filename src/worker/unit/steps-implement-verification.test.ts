import assert from "node:assert/strict";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
import { test } from "node:test";
import { join } from "node:path";
import { temporary } from "../../kernel/test-support.ts";
import { existsSync, readFileSync } from "node:fs";
import { EnvironmentSource } from "../../kernel/devcontainer.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import { RecordKind, type TelemetryRecord } from "../../tracking/contract.ts";
import { EndReason, type ExecutionEnd } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import { VERIFICATION_INFRASTRUCTURE_FAILED } from "./verification.ts";
import { SpanOperation } from "./telemetry.ts";
import { VerificationContext } from "./method-telemetry.ts";
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
  recordSpans,
  task,
} from "./test-support.ts";

const SIGNAL_KILL = "sh -c 'kill -9 $$'";
const EXIT_KILL = "sh -c 'kill -9 $$'; exit $?";
const ONE_TURN = 1;
const ONE_TOOL_TURN = 2;
const FOUR_TURNS = 4;
const SETUP_MARKER = "setup-ran";
const SETUP_INSTRUCTION = "Fix the setup: test -e fixed failed.";
const WALL_DEADLINE_MS = 300;
const ONE_RUN = 1;
const TWO_RUNS = 2;

function countCommand(path: string): string {
  return `echo x >> ${path}`;
}

function runsOf(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").trim().split("\n").length;
}

function liveCommands(
  records: readonly TelemetryRecord[],
  context: VerificationContext,
): string[] {
  const texts = new Map(
    records.flatMap((record) =>
      record.kind === RecordKind.Text ? [[record.text_id, record.text]] : [],
    ),
  );
  return records.flatMap((record) =>
    record.kind === RecordKind.Span &&
    record.operation === SpanOperation.Verification &&
    record.start_time !== undefined &&
    record.attributes?.["kanthord.verification.context"] === context
      ? [texts.get(`${record.span_id}:command`) ?? ""]
      : [],
  );
}

function acceptEvidence(h: Awaited<ReturnType<typeof fixture>>): void {
  h.run.clients.mission = {
    ...h.run.clients.mission,
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
}

function writeTurn(path: string) {
  return fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
    stopReason: "toolUse",
  });
}

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
    cause: attributed(
      CauseCategory.Infrastructure,
      CauseSubcategory.VerificationKilled,
    ),
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

test("a persistent kill in a node verification at the release gate stops with the infrastructure code", async (t) => {
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
      digest: "d".repeat(64),
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
        digest: "d".repeat(64),
      },
    ),
    {
      reason: EndReason.EnvironmentFailed,
      code: EnvironmentFailure.SetupFailed,
    },
  );
});

test("a pending node-head setup reruns before the next verification and passes once the agent fixes it", async (t) => {
  const current = task("setup", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage(
        fauxToolCall("write", { path: "fixed", content: "node" }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("work"),
    ],
  );
  h.setup = h.setup.map((entry) => ({
    ...entry,
    environment: { postCreateCommand: "test -e fixed" },
  }));
  h.setupPending = true;
  const result = await runTask(h, current, SETUP_INSTRUCTION);
  assert.equal(result.kind, TaskResultKind.Complete);
  assert.equal(h.setupPending, false);
  assert.ok(JSON.stringify(h.provider.calls[0]).includes(SETUP_INSTRUCTION));
});

test("a pending node-head setup that keeps failing sends its own command in the revision turn", async (t) => {
  const current = task("setup", "true");
  const h = await fixture(
    t,
    [current],
    [
      fauxAssistantMessage("work"),
      fauxAssistantMessage("revised"),
      fauxAssistantMessage("revised again"),
    ],
  );
  h.setup = h.setup.map((entry) => ({
    ...entry,
    environment: { postCreateCommand: "test -e never-fixed" },
  }));
  h.setupPending = true;
  await assert.rejects(runTask(h, current), { reason: EndReason.NoProgress });
  assert.equal(h.setupPending, true);
  assert.ok(
    JSON.stringify(h.provider.calls.at(-1)).includes("test -e never-fixed"),
  );
});

test("the setup instruction of a node-head failure goes to the first pending task", async (t) => {
  const current = task("setup", "true");
  const h = await fixture(t, [current], [fauxAssistantMessage("never")]);
  h.setupInstruction = SETUP_INSTRUCTION;
  const instructions: Array<string | null> = [];
  await executionBoundary(h.run, () =>
    runStepsImplement(h, async (_state, _task, instruction) => {
      instructions.push(instruction);
      return { kind: TaskResultKind.BudgetEnd };
    }),
  );
  assert.deepEqual(instructions, [SETUP_INSTRUCTION]);
});

test("a task unit skips each node command in the live checkout and runs each own command", async (t) => {
  const directory = temporary(t);
  const node = countCommand(join(directory, "node"));
  const own = countCommand(join(directory, "own"));
  const base = task("own", own);
  const current = {
    ...base,
    content: { ...base.content, verifications: [node, own] },
  };
  const h = await fixture(
    t,
    [current],
    [writeTurn("work"), fauxAssistantMessage("work")],
  );
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: [node] },
  };
  recordReleases(h);
  acceptEvidence(h);
  const records = recordSpans(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(runsOf(join(directory, "node")), ONE_RUN);
  assert.equal(runsOf(join(directory, "own")), TWO_RUNS);
  assert.deepEqual(liveCommands(records, VerificationContext.Task), [own]);
});

test("an implement node with no task runs no live verification and runs each node verification once at the release gate", async (t) => {
  const directory = temporary(t);
  const node = countCommand(join(directory, "node"));
  const h = await fixture(
    t,
    [],
    [writeTurn("work"), fauxAssistantMessage("work")],
  );
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: [node] },
  };
  recordReleases(h);
  acceptEvidence(h);
  const records = recordSpans(h);
  assert.deepEqual(await executionBoundary(h.run, () => runStepsImplement(h)), {
    kind: "released",
    furtherWork: false,
  });
  assert.equal(runsOf(join(directory, "node")), ONE_RUN);
  assert.deepEqual(liveCommands(records, VerificationContext.Node), []);
});

test("a passing own command at a budget end releases further work with no operation_failed stop", async (t) => {
  const marker = join(temporary(t), "marker");
  const current = task("budget", `touch ${marker}`);
  const h = await fixture(
    t,
    [current],
    [writeTurn("work"), fauxAssistantMessage("work")],
  );
  h.agent.budget.exhausted = () => existsSync(marker);
  const bodies = recordReleases(h);
  acceptEvidence(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.ok("furtherWork" in end && end.furtherWork);
  assert.notEqual(end.stop?.reason, EndReason.OperationFailed);
  assert.equal(bodies.length, ONE_TURN);
});
