import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  type ChainNode,
  stepNode,
} from "./chain.ts";
import { EndReason } from "./execution-stop.ts";
import {
  evaluationTasksNodes,
  foundryEvaluation,
} from "./foundry-evaluation.ts";
import { EVALUATION_PORTS, type EvaluationPorts } from "./foundry-ports.ts";
import { assessmentSubmit } from "./step-assessment-submit.ts";
import { assetsPlace } from "./step-assets-place.ts";
import { envSetupReview } from "./step-env-setup-host.ts";
import {
  inputsReadAttemptEvidence,
  inputsReadReviewRound,
  inputsReadRevision,
} from "./step-inputs-read-host.ts";
import { setupEntriesReview } from "./step-setup-entries-host.ts";
import { workspaceReviewSnapshot } from "./step-workspace-review.ts";
import { Phase } from "./telemetry.ts";

export function evaluationPrepareNodes(): ChainNode[] {
  return [
    stepNode(workspaceReviewSnapshot),
    stepNode(setupEntriesReview),
    stepNode(envSetupReview),
    stepNode(assetsPlace),
  ];
}

export function evaluationChain(): Chain<EvaluationPorts> {
  return chain<EvaluationPorts>(ChainId.Evaluation, EVALUATION_PORTS)
    .phase(Phase.Prepare)
    .step(inputsReadRevision)
    .step(inputsReadAttemptEvidence)
    .step(inputsReadReviewRound)
    .nodes(evaluationPrepareNodes())
    .tasks({
      name: "foundryEvaluation",
      ports: EVALUATION_PORTS,
      nodes: evaluationTasksNodes(),
      async run(ctx, control, host) {
        const end = await foundryEvaluation(
          {
            ...control,
            claim: ctx.claim,
            setup: ctx.setup,
            revision: ctx.revision,
            reviewWorkspace: ctx.reviewWorkspace,
            testedInput: ctx.testedInput,
            baseHead: ctx.baseHead,
            setupFailure: ctx.setupFailure,
            placed: ctx.placed,
            reviewRound: ctx.reviewRound,
          },
          host,
        );
        Object.assign(ctx, end.result);
        return end;
      },
    })
    .phase(Phase.Finish)
    .step(assessmentSubmit)
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.AssessmentAbsent })
    .build();
}
