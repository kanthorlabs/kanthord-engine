import { fetchAtRelease } from "./base-refresh.ts";
import { DeadlineKind, type Step } from "./chain.ts";
import { next } from "./step-support.ts";

export const baseFetch: Step<unknown, "state", never> = {
  id: "base.fetch",
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: ["operation_failed/repository.connector.git_failed"],
  note: "base_branch and upstream_branch of each checkout",
  async run({ state }, scope) {
    await fetchAtRelease(state);
    return next(scope);
  },
};
