import assert from "node:assert/strict";
import { refreshAtClaim, RefreshResult } from "./base-refresh.ts";
import { DeadlineKind, type Step, type StopCode } from "./chain.ts";
import { budgetEnd, next } from "./step-support.ts";

const NO_CHECKOUTS = 0;
const STOPS: readonly StopCode[] = [
  "operation_failed/repository.connector.git_failed",
  "operation_failed/worker.turn.*",
  "operation_failed/worker.git.commit_failed",
  "operation_failed/worker.merge.markers_left",
  "provider_failed",
];
const NOTE =
  "per checkout and merged branch: merge, Conflict turn on a conflict, gate G; budget end";

export const baseRefreshClaim: Step<unknown, "state", never> = {
  id: "base.refresh(claim)",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: STOPS,
  llm: true,
  note: NOTE,
  async run({ state }, scope) {
    assert.ok(state.checkouts.length > NO_CHECKOUTS);
    state.refreshed = await refreshAtClaim(state);
    return state.refreshed === RefreshResult.BudgetEnd
      ? budgetEnd(scope)
      : next(scope);
  },
};

export const baseRefreshRelease: Step<unknown, "state", never> = {
  id: "base.refresh(release)",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: STOPS,
  llm: true,
  note: NOTE,
  async run({ state }, scope) {
    return (await refreshAtClaim(state)) === RefreshResult.BudgetEnd
      ? budgetEnd(scope)
      : next(scope);
  },
};
