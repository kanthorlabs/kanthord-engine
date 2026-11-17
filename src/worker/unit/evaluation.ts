import type { SetupFailure } from "./environment-setup.ts";
import { AssessmentResult } from "../../mission/contract.ts";
import type { ExecutionBudget } from "./budget.ts";
import { evaluationChain } from "./chain-evaluation.ts";
import { readPinnedRevision } from "./node-reads.ts";
import { runChain } from "./chain-runner.ts";
import { hostOf, seedOf } from "./step-support.ts";
import {
  EndReason,
  type ExecutionEnd,
  type ExecutionRun,
} from "./execution-run.ts";
import { failedVerificationReport } from "./judgement.ts";
import { EvaluationStage } from "./rework-cause.ts";
import type { StepsInput } from "./steps-implement.ts";
import { ActionResultKind } from "../contract.ts";
import {
  type AgentOpener,
  agentPort,
  evaluationPorts,
} from "./worker-ports.ts";

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

export const VERIFICATION_SUBJECT = "Evaluation verification results";

export function setupFailureAssessment(setupFailure: SetupFailure | null) {
  if (setupFailure === null) return null;
  return {
    result: AssessmentResult.CriterionNotMet,
    rationale: failedVerificationReport(
      setupFailure.run,
      setupFailure.commands,
    ),
    proposals: [],
  };
}

export async function runEvaluation(
  input: StepsInput,
  run: ExecutionRun,
  budget: ExecutionBudget,
  openAgent: AgentOpener,
): Promise<ExecutionEnd> {
  const revision = await readPinnedRevision(run);
  return runChain(
    evaluationChain(),
    { seed: { ...seedOf(input), revision } },
    {
      run,
      budget,
      resources: new AsyncDisposableStack(),
      host: hostOf(input, openAgent),
      ports: evaluationPorts(run, agentPort({ run, budget, open: openAgent })),
    },
  );
}
