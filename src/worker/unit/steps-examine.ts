import type { Revision } from "../../mission/contract.ts";
import type { ExecutionRun } from "./execution-run.ts";
import type { ExecutionEnd } from "./execution-stop.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { ExecutionBudget } from "./budget.ts";
import { examineChain } from "./chain-examine.ts";
import { runChain } from "./chain-runner.ts";
import { hostOf, seedOf } from "./step-support.ts";
import { type AgentOpener, examinePorts } from "./worker-ports.ts";

export function runStepsExamine(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  budget: ExecutionBudget,
  openAgent: AgentOpener,
): Promise<ExecutionEnd> {
  return runChain(
    examineChain(),
    { seed: { ...seedOf(input), revision } },
    {
      run,
      budget,
      resources: new AsyncDisposableStack(),
      host: hostOf(input),
      ports: examinePorts({ run, budget, open: openAgent }),
    },
  );
}
