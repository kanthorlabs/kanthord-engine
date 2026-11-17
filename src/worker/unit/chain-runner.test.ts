import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  attributed,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
import { background, CancellationContext } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { stopAfter } from "../../kernel/test-support.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import {
  BudgetEndKind,
  chain,
  type ChainBuilder,
  ChainBuildError,
  type ChainFoundryStep,
  ChainId,
  type ChainNode,
  ChainRule,
  type ChainSeed,
  type ChainStep,
  type ChainTasks,
  DeadlineKind,
  type ExecutionCtx,
  type Key,
  type LoopFrame,
  loopNode,
  StepKind,
  stepNode,
} from "./chain.ts";
import { type ChainIo, executionBoundary, runChain } from "./chain-runner.ts";
import { ExecutionRun } from "./execution-run.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  ExecutionStop,
} from "./execution-stop.ts";
import type { CommonPorts } from "./foundry-ports.ts";
import { runTasks } from "./foundry.ts";
import type { MethodClients } from "./method-clients.ts";
import { Phase } from "./telemetry.ts";

const WALL_TIME_MS = 60000;
const RELEASED: ExecutionEnd = {
  kind: ExecutionEndKind.Released,
  furtherWork: false,
};
const EXITED: ExecutionEnd = {
  kind: ExecutionEndKind.Released,
  furtherWork: true,
};
const FRAMES = 2;
const STOP_CODE = "test.stop";
const CHECKPOINT_FAILED = "checkpoint failed";
const DISPOSALS = 2;
const UNWRITTEN_KEY: Key = "agent";

interface Harness {
  io: ChainIo;
  seed: ChainSeed;
  trace: string[];
  logs: string[];
  releases: unknown[];
}

function harness(t: TestContext, stop?: CancellationContext): Harness {
  const claim = {
    execution_id: createIdentity("execution"),
    node_id: createIdentity("node"),
    attempt: 1,
    pinned_revision: 1,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    created_at: Date.now(),
    expired_at: Date.now() + WALL_TIME_MS,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
  const logs: string[] = [];
  const releases: unknown[] = [];
  const run = new ExecutionRun({
    claim,
    clients: {
      scheduler: {
        executionRelease: async (input: { body: unknown }) => {
          releases.push(input.body);
          return { type: "completed", status: 200, data: {} };
        },
      },
    } as unknown as MethodClients,
    credentials: { release: async () => {} },
    context: background,
    ...(stop === undefined ? {} : { stop }),
    log: (record) => logs.push(String(record.msg)),
  });
  stopAfter(t, () => run.dispose());
  const trace: string[] = [];
  const resources = new AsyncDisposableStack();
  resources.defer(() => void trace.push("dispose first"));
  resources.defer(() => void trace.push("dispose second"));
  return {
    io: {
      run,
      budget: new ExecutionBudget({
        ...claim,
        resource_budget: { wall_time_ms: WALL_TIME_MS },
      }),
      resources,
      host: { env: {} } as unknown as ChainIo["host"],
      ports: {} as ChainIo["ports"],
    },
    seed: { claim } as ChainSeed,
    trace,
    logs,
    releases,
  };
}

interface Act {
  kind?: StepKind;
  reads?: readonly Key[];
  patch?: Partial<ExecutionCtx>;
  work?: (ctx: Partial<ExecutionCtx>) => void;
}

function stepOf(h: Harness, id: string, act: Act = {}): ChainStep {
  return {
    id,
    deadline: DeadlineKind.Work,
    reads: act.reads ?? [],
    writes: Object.keys(act.patch ?? {}) as Key[],
    stops: [],
    async run(ctx: Partial<ExecutionCtx>, scope: unknown) {
      h.trace.push(id);
      act.work?.(ctx);
      return {
        kind: act.kind ?? StepKind.Next,
        patch: act.patch ?? {},
        scope,
      };
    },
  };
}

function returningStep(
  h: Harness,
  id: string,
  work: () => ExecutionStop,
): ChainFoundryStep {
  return {
    foundry: true,
    id,
    deadline: DeadlineKind.Work,
    reads: [],
    writes: [],
    stops: [],
    ports: [],
    async run(_ctx: Partial<ExecutionCtx>, scope: unknown) {
      h.trace.push(id);
      return { kind: StepKind.Stop, stop: work(), patch: {}, scope };
    },
  };
}

function abortedStep(
  h: Harness,
  id: string,
  abort: () => void,
): ChainFoundryStep {
  return {
    foundry: true,
    id,
    deadline: DeadlineKind.Work,
    reads: [],
    writes: [],
    stops: [],
    ports: [],
    async run(_ctx: Partial<ExecutionCtx>, scope: unknown) {
      h.trace.push(id);
      abort();
      return { kind: StepKind.Next, patch: {}, scope };
    },
  };
}

function finalStep(h: Harness, id: string, end: ExecutionEnd): ChainStep {
  return stepOf(h, id, { kind: StepKind.Closed, patch: { end } });
}

function foundryOf(step: ChainStep): ChainFoundryStep {
  return step.foundry ? step : { ...step, foundry: true, ports: [] };
}

function tasksOf(nodes: readonly ChainNode[]): ChainTasks<CommonPorts> {
  return {
    name: "foundryTest",
    ports: [],
    nodes,
    async run(ctx, control, host) {
      const end = await runTasks(
        { nodes, seed: ctx, resultOf: (reached) => reached },
        control,
        host,
      );
      Object.assign(ctx, end.result);
      return end;
    },
  };
}

function stoppable(h: Harness, work: ChainStep): ChainBuilder<CommonPorts> {
  return chain<CommonPorts>(ChainId.Implement, [])
    .phase(Phase.Prepare)
    .step(stepOf(h, "prepare"))
    .tasks(tasksOf([stepNode(foundryOf(work))]))
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [stepNode(finalStep(h, "exit", EXITED))],
    });
}

test("a chain runs each phase, each frame of a loop and the final step, then disposes the resources in reverse order", async (t) => {
  const h = harness(t);
  const frame: LoopFrame<number> = {
    reads: ["setupPending"],
    init: () => 1,
    body: [
      stepNode(
        foundryOf(
          stepOf(h, "turn", {
            reads: ["setupPending"],
            work: (ctx) => assert.equal(ctx.setupPending, true),
          }),
        ),
      ),
    ],
    next: (_ctx, scope) => (scope < FRAMES ? scope + 1 : null),
  };
  const built = chain<CommonPorts>(ChainId.Implement, [])
    .phase(Phase.Prepare)
    .step(stepOf(h, "prepare", { patch: { setupPending: true } }))
    .tasks(tasksOf([loopNode("turns", frame)]))
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd })
    .build();
  assert.deepEqual(await runChain(built, { seed: h.seed }, h.io), RELEASED);
  assert.deepEqual(h.trace, [
    "prepare",
    "turn",
    "turn",
    "release",
    "dispose second",
    "dispose first",
  ]);
});

test("a build rejects a step that reads a key with no earlier writer", (t) => {
  const h = harness(t);
  const built = chain<CommonPorts>(ChainId.Examine, [])
    .phase(Phase.Prepare)
    .step(stepOf(h, "reader", { reads: [UNWRITTEN_KEY] }))
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd });
  assert.throws(
    () => built.build(),
    (error) => error instanceof ChainBuildError && error.key === UNWRITTEN_KEY,
  );
});

const PHASE_PORT = "secrets.redact";
const WORK_NODE = "step work";
const READER_NODE = "step reader";
const SSH_ACCESS_KEY: Key = "sshAccess";

test("a build rejects a tasks step whose port is not in the port set of the tasks phase", (t) => {
  const h = harness(t);
  const built = chain<CommonPorts>(ChainId.Examine, [PHASE_PORT])
    .phase(Phase.Prepare)
    .step({ ...foundryOf(stepOf(h, "prepare")), ports: [PHASE_PORT] })
    .tasks(
      tasksOf([
        stepNode({ ...foundryOf(stepOf(h, "work")), ports: [PHASE_PORT] }),
      ]),
    )
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd });
  assert.throws(
    () => built.build(),
    (error) =>
      error instanceof ChainBuildError &&
      error.node === WORK_NODE &&
      error.rule === ChainRule.PortOutsidePhase &&
      error.port === PHASE_PORT,
  );
});

test("a build rejects a host step in a tasks phase", (t) => {
  const h = harness(t);
  const built = chain<CommonPorts>(ChainId.Examine, [])
    .phase(Phase.Prepare)
    .step(stepOf(h, "prepare"))
    .tasks(tasksOf([stepNode(stepOf(h, "work"))]))
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd });
  assert.throws(
    () => built.build(),
    (error) =>
      error instanceof ChainBuildError &&
      error.node === WORK_NODE &&
      error.rule === ChainRule.HostStepInTasks,
  );
});

test("a build rejects a Foundry step that reads sshAccess", (t) => {
  const h = harness(t);
  const built = chain<CommonPorts>(ChainId.Examine, [])
    .phase(Phase.Prepare)
    .step(foundryOf(stepOf(h, "reader", { reads: [SSH_ACCESS_KEY] })))
    .phase(Phase.Finish)
    .step(finalStep(h, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd });
  assert.throws(
    () => built.build(),
    (error) =>
      error instanceof ChainBuildError &&
      error.node === READER_NODE &&
      error.rule === ChainRule.FoundryReadsSshAccess &&
      error.key === SSH_ACCESS_KEY,
  );
});

test("a budget end after prepare runs the exit nodes, and a budget end in prepare stops with budget_end/wall_time", async (t) => {
  const exited = harness(t);
  const built = stoppable(
    exited,
    stepOf(exited, "work", { kind: StepKind.BudgetEnd }),
  ).build();
  assert.deepEqual(
    await runChain(built, { seed: exited.seed }, exited.io),
    EXITED,
  );
  assert.deepEqual(exited.trace.slice(0, -DISPOSALS), [
    "prepare",
    "work",
    "exit",
  ]);
  const early = harness(t);
  const stopped = chain<CommonPorts>(ChainId.Implement, [])
    .phase(Phase.Prepare)
    .step(stepOf(early, "prepare", { kind: StepKind.BudgetEnd }))
    .phase(Phase.Finish)
    .step(finalStep(early, "release", RELEASED))
    .budgetEnd({
      kind: BudgetEndKind.Exit,
      nodes: [stepNode(finalStep(early, "exit", EXITED))],
    })
    .build();
  await assert.rejects(
    runChain(stopped, { seed: early.seed }, early.io),
    (error) =>
      error instanceof ExecutionStop &&
      error.reason === EndReason.BudgetEnd &&
      error.code === BudgetLimit.WallTime,
  );
  assert.deepEqual(early.trace.slice(0, -DISPOSALS), ["prepare"]);
});

test("a stop after prepare runs the stop nodes before the dispose, keeps the stop when a stop node fails and throws the stop", async (t) => {
  const h = harness(t);
  const built = stoppable(
    h,
    stepOf(h, "work", {
      work: () => h.io.run.stop(EndReason.OperationFailed, STOP_CODE),
    }),
  )
    .onStop([
      stepNode(
        stepOf(h, "checkpoint", {
          reads: ["stop"],
          work: (ctx) => assert.equal(ctx.stop?.code, STOP_CODE),
        }),
      ),
      stepNode(
        stepOf(h, "push", {
          work: () => {
            throw new Error("push failed");
          },
        }),
      ),
    ])
    .build();
  await assert.rejects(
    runChain(built, { seed: h.seed }, h.io),
    (error) => error instanceof ExecutionStop && error.code === STOP_CODE,
  );
  assert.deepEqual(h.trace, [
    "prepare",
    "work",
    "checkpoint",
    "push",
    "dispose second",
    "dispose first",
  ]);
  assert.deepEqual(h.logs, [CHECKPOINT_FAILED]);
});

test("a revoked stop and a stop in prepare run no stop node", async (t) => {
  const revoked = harness(t);
  const onStop = (h: Harness) => [stepNode(stepOf(h, "checkpoint"))];
  await assert.rejects(
    runChain(
      stoppable(
        revoked,
        stepOf(revoked, "work", {
          work: () => revoked.io.run.stop(EndReason.Revoked),
        }),
      )
        .onStop(onStop(revoked))
        .build(),
      { seed: revoked.seed },
      revoked.io,
    ),
    (error) =>
      error instanceof ExecutionStop && error.reason === EndReason.Revoked,
  );
  assert.deepEqual(revoked.trace.slice(0, -DISPOSALS), ["prepare", "work"]);
  const early = harness(t);
  const built = chain<CommonPorts>(ChainId.Implement, [])
    .phase(Phase.Prepare)
    .step(
      stepOf(early, "prepare", {
        work: () => early.io.run.stop(EndReason.OperationFailed, STOP_CODE),
      }),
    )
    .phase(Phase.Finish)
    .step(finalStep(early, "release", RELEASED))
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.BudgetEnd })
    .onStop(onStop(early))
    .build();
  await assert.rejects(
    runChain(built, { seed: early.seed }, early.io),
    (error) => error instanceof ExecutionStop && error.code === STOP_CODE,
  );
  assert.deepEqual(early.trace.slice(0, -DISPOSALS), ["prepare"]);
});

test("a stored stop wins over the stop that a tasks step returns", async (t) => {
  const h = harness(t);
  const built = stoppable(
    h,
    returningStep(h, "work", () => {
      assert.throws(() => h.io.run.stop(EndReason.Revoked));
      return new ExecutionStop(EndReason.OperationFailed, STOP_CODE);
    }),
  )
    .onStop([stepNode(stepOf(h, "checkpoint"))])
    .build();
  assert.deepEqual(
    await executionBoundary(h.io.run, () =>
      runChain(built, { seed: h.seed }, h.io),
    ),
    { kind: ExecutionEndKind.Ended, reason: EndReason.Revoked, code: null },
  );
  assert.deepEqual(h.trace.slice(0, -DISPOSALS), ["prepare", "work"]);
  assert.deepEqual(h.releases, []);
});

const REQUESTED_STOPS = [
  EndReason.HumanPaused,
  EndReason.InstanceArchived,
  EndReason.WorkerStopped,
];

for (const reason of REQUESTED_STOPS) {
  test(`a requested stop with the reason ${reason} wins over the stop of the tasks step that it aborted`, async (t) => {
    const order = new CancellationContext();
    const h = harness(t, order);
    const built = stoppable(
      h,
      returningStep(h, "work", () => {
        order.cancel(new ExecutionStop(reason, null));
        return new ExecutionStop(EndReason.OperationFailed, STOP_CODE);
      }),
    )
      .onStop([
        stepNode(
          stepOf(h, "checkpoint", {
            reads: ["stop"],
            work: (ctx) => assert.equal(ctx.stop?.reason, reason),
          }),
        ),
      ])
      .build();
    const stop = {
      reason,
      code: null,
      cause: attributed(CauseCategory.Human, CauseSubcategory.Intervention),
    };
    assert.deepEqual(
      await executionBoundary(h.io.run, () =>
        runChain(built, { seed: h.seed }, h.io),
      ),
      { kind: ExecutionEndKind.Released, furtherWork: true, stop },
    );
    assert.deepEqual(h.releases, [{ further_work: true, stop }]);
    assert.deepEqual(h.trace.slice(0, -DISPOSALS), [
      "prepare",
      "work",
      "checkpoint",
    ]);
  });
}

test("a requested stop wins when the tasks step that it aborted returns next", async (t) => {
  const order = new CancellationContext();
  const h = harness(t, order);
  const reason = EndReason.HumanPaused;
  const built = stoppable(
    h,
    abortedStep(h, "work", () => order.cancel(new ExecutionStop(reason, null))),
  )
    .onStop([stepNode(stepOf(h, "checkpoint"))])
    .build();
  const stop = {
    reason,
    code: null,
    cause: attributed(CauseCategory.Human, CauseSubcategory.Intervention),
  };
  assert.deepEqual(
    await executionBoundary(h.io.run, () =>
      runChain(built, { seed: h.seed }, h.io),
    ),
    { kind: ExecutionEndKind.Released, furtherWork: true, stop },
  );
  assert.deepEqual(h.releases, [{ further_work: true, stop }]);
  assert.deepEqual(h.trace.slice(0, -DISPOSALS), [
    "prepare",
    "work",
    "checkpoint",
  ]);
});

test("an abort with no stop leaves the result of the tasks step and the walk goes on", async (t) => {
  const order = new CancellationContext();
  const h = harness(t, order);
  const built = stoppable(
    h,
    abortedStep(h, "work", () => order.cancel()),
  ).build();
  assert.deepEqual(
    await executionBoundary(h.io.run, () =>
      runChain(built, { seed: h.seed }, h.io),
    ),
    RELEASED,
  );
  assert.deepEqual(h.trace.slice(0, -DISPOSALS), [
    "prepare",
    "work",
    "release",
  ]);
  assert.deepEqual(h.releases, []);
});
