import type { ExecutionBudget } from "./budget.ts";
import { evaluationChain } from "./chain-evaluation.ts";
import { runChain } from "./chain-runner.ts";
import { hostOf, seedOf } from "./chain-host.ts";
import type { ExecutionRun } from "./execution-run.ts";
import { EndReason, type ExecutionEnd } from "./execution-stop.ts";
import { EvaluationStage } from "./rework-cause.ts";
import type { HostInput } from "./chain-host.ts";
import { ActionResultKind } from "../contract.ts";
import { type AgentOpener, evaluationPorts } from "./worker-ports.ts";

export { EvaluationStage };

export const ACCEPTED_ITEM_KINDS: readonly ActionResultKind[] = [
  ActionResultKind.Submitted,
  ActionResultKind.AwaitingPrerequisite,
];

export async function requestAndRelease(
  run: ExecutionRun,
): Promise<ExecutionEnd> {
  const items = await run.requestActions();
  if (!items.every((item) => ACCEPTED_ITEM_KINDS.includes(item.kind)))
    return run.stop(EndReason.ActionUnsettled);
  return run.release(false);
}

export async function runEvaluation(
  input: HostInput,
  run: ExecutionRun,
  budget: ExecutionBudget,
  openAgent: AgentOpener,
): Promise<ExecutionEnd> {
  return runChain(
    evaluationChain(),
    { seed: seedOf(input) },
    {
      run,
      budget,
      capabilities: [],
      resources: new AsyncDisposableStack(),
      host: hostOf(input),
      ports: evaluationPorts({ run, budget, open: openAgent }),
    },
  );
}
