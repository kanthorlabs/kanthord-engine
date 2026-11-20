import {
  DeadlineKind,
  type ExecutionCtx,
  StepKind,
  type StepResult,
} from "./chain.ts";
import type { Step } from "./chain-host.ts";
import type { ExecutionEnd } from "./execution-stop.ts";

const NO_UNITS = 0;

function closed<S>(scope: S, end: ExecutionEnd): StepResult<S, "end"> {
  const patch: Pick<ExecutionCtx, "end"> = { end };
  return { kind: StepKind.Closed, patch, scope };
}

export const executionRelease: Step<unknown, "claim", "end"> = {
  id: "execution.release",
  deadline: DeadlineKind.Cleanup,
  final: true,
  reads: ["claim"],
  writes: ["end"],
  stops: [],
  note: "further_work false",
  async run(_ctx, scope, io) {
    return closed(scope, await io.run.release(false));
  },
};

export const executionReleaseFurtherWork: Step<unknown, "claim", "end"> = {
  id: "execution.release",
  deadline: DeadlineKind.Cleanup,
  final: true,
  reads: ["claim"],
  writes: ["end"],
  stops: [],
  note: "further_work true; no stop",
  async run(_ctx, scope, io) {
    return closed(scope, await io.run.release(true));
  },
};

export const executionReleaseBudgetEnd: Step<
  unknown,
  "state" | "completedUnits",
  "end"
> = {
  id: "execution.release",
  deadline: DeadlineKind.Cleanup,
  final: true,
  reads: ["state", "completedUnits"],
  writes: ["end"],
  stops: [],
  note: "further_work true; stop budget_end/<limit> only when no unit completed",
  async run(ctx, scope, io) {
    return closed(
      scope,
      await io.run.release(
        true,
        ctx.completedUnits.size === NO_UNITS
          ? ctx.state.agent.budget.limit()
          : null,
      ),
    );
  },
};
