import type { ExecutionRun } from "./execution-run.ts";
import type { ExecutionEnd } from "./execution-stop.ts";
import type { HostInput } from "./chain-host.ts";
import type { ExecutionBudget } from "./budget.ts";
import { examineChain } from "./chain-examine.ts";
import { runChain } from "./chain-runner.ts";
import { hostOf, seedOf } from "./chain-host.ts";
import { type AgentOpener, examinePorts } from "./worker-ports.ts";

export function runStepsExamine(
  input: HostInput,
  run: ExecutionRun,
  budget: ExecutionBudget,
  openAgent: AgentOpener,
): Promise<ExecutionEnd> {
  return runChain(
    examineChain(),
    { seed: seedOf(input) },
    {
      run,
      budget,
      capabilities: [],
      resources: new AsyncDisposableStack(),
      host: hostOf(input),
      ports: examinePorts({ run, budget, open: openAgent }),
    },
  );
}
