import type { Revision } from "../../mission/contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import type { ExecutionEnd, ExecutionRun } from "./execution-run.ts";
import type { StepsInput } from "./steps-implement.ts";
import type { ExecutionBudget } from "./budget.ts";
import { examineChain } from "./chain-examine.ts";
import { runChain } from "./chain-runner.ts";
import { hostOf, seedOf } from "./step-support.ts";
import { workerPorts } from "./worker-ports.ts";

export const REPORT_SUBJECT = "Report on current dependency outcomes";
export const REPORT_MEDIA_TYPE = "text/markdown";

export function runStepsExamine(
  input: StepsInput,
  run: ExecutionRun,
  revision: Revision,
  budget: ExecutionBudget,
  openAgent: (directory: string) => Promise<NativeAgent>,
): Promise<ExecutionEnd> {
  return runChain(
    examineChain(),
    { seed: { ...seedOf(input), revision } },
    {
      run,
      budget,
      resources: new AsyncDisposableStack(),
      host: hostOf(input, openAgent),
      ports: workerPorts(input, run),
    },
  );
}
