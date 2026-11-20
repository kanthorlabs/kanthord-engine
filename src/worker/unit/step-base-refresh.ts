import assert from "node:assert/strict";
import { refreshAtClaim, RefreshResult } from "./base-refresh.ts";
import { DeadlineKind, type FoundryStep, type StopCode } from "./chain.ts";
import { budgetEnd, next, stopsReturned } from "./step-support.ts";

const NO_CHECKOUTS = 0;
const STOPS: readonly StopCode[] = [
  "operation_failed/repository.connector.git_failed",
  "operation_failed/worker.turn.*",
  "operation_failed/worker.git.commit_failed",
  "operation_failed/worker.merge.markers_left",
  "provider_failed",
];
const NOTE =
  "per checkout and merged branch: merge, Conflict turn on a conflict, gate G; budget end after the turn: one more marker check records the open merge";

export const baseRefreshClaim: FoundryStep<unknown, "state", never> = {
  foundry: true,
  id: "base.refresh(claim)",
  ports: ["secrets.redact"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: STOPS,
  llm: true,
  note: NOTE,
  run({ state }, scope) {
    return stopsReturned(scope, async () => {
      assert.ok(state.checkouts.length > NO_CHECKOUTS);
      state.refreshed = await refreshAtClaim(state);
      return state.refreshed === RefreshResult.BudgetEnd
        ? budgetEnd(scope)
        : next(scope);
    });
  },
};

export const baseRefreshRelease: FoundryStep<unknown, "state", never> = {
  foundry: true,
  id: "base.refresh(release)",
  ports: ["secrets.redact"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: STOPS,
  llm: true,
  note: NOTE,
  run({ state }, scope) {
    return stopsReturned(scope, async () =>
      (await refreshAtClaim(state)) === RefreshResult.BudgetEnd
        ? budgetEnd(scope)
        : next(scope),
    );
  },
};
