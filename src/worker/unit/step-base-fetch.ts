import { fetchAtRelease } from "./base-refresh.ts";
import { DeadlineKind, type FoundryStep } from "./chain.ts";
import type { ImplementPorts } from "./foundry-ports.ts";
import { next, stopsReturned } from "./step-support.ts";

export const baseFetch: FoundryStep<unknown, "state", never, ImplementPorts> = {
  foundry: true,
  id: "base.fetch",
  ports: ["repository.fetchBase"],
  deadline: DeadlineKind.Work,
  reads: ["state"],
  writes: [],
  stops: ["operation_failed/repository.connector.git_failed"],
  note: "base_branch and upstream_branch of each checkout",
  run({ state }, scope, io) {
    return stopsReturned(scope, async () => {
      await fetchAtRelease(state, io.ports);
      return next(scope);
    });
  },
};
