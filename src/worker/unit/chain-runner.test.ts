import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { stopAfter } from "../../kernel/test-support.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import {
  BudgetEndKind,
  chain,
  type ChainBuilder,
  ChainBuildError,
  ChainId,
  type ChainSeed,
  type ChainStep,
  DeadlineKind,
  type ExecutionCtx,
  type Key,
  type LoopFrame,
  StepKind,
  stepNode,
} from "./chain.ts";
import { type ChainIo, runChain } from "./chain-runner.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  ExecutionRun,
  ExecutionStop,
} from "./execution-run.ts";
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
}

function harness(t: TestContext): Harness {
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
  const run = new ExecutionRun({
    claim,
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
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
      host: {} as ChainIo["host"],
      ports: {} as ChainIo["ports"],
    },
    seed: { claim } as ChainSeed,
    trace,
    logs,
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

function finalStep(h: Harness, id: string, end: ExecutionEnd): ChainStep {
  return stepOf(h, id, { kind: StepKind.Closed, patch: { end } });
}

function stoppable(h: Harness, work: ChainStep): ChainBuilder {
  return chain(ChainId.Implement)
    .phase(Phase.Prepare)
    .step(stepOf(h, "prepare"))
    .phase(Phase.Tasks)
    .step(work)
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
        stepOf(h, "turn", {
          reads: ["setupPending"],
          work: (ctx) => assert.equal(ctx.setupPending, true),
        }),
      ),
    ],
    next: (_ctx, scope) => (scope < FRAMES ? scope + 1 : null),
  };
  const built = chain(ChainId.Implement)
    .phase(Phase.Prepare)
    .step(stepOf(h, "prepare", { patch: { setupPending: true } }))
    .phase(Phase.Tasks)
    .loop("turns", frame)
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
  const built = chain(ChainId.Examine)
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
  const stopped = chain(ChainId.Implement)
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
  const built = chain(ChainId.Implement)
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
