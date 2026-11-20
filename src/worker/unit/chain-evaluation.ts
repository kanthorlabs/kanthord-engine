import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  type ChainNode,
  type ChainTasks,
  stepNode,
} from "./chain.ts";
import { EndReason } from "./execution-stop.ts";
import {
  evaluationTasksNodes,
  runEvaluationTasks,
} from "./foundry-evaluation.ts";
import { EVALUATION_PORTS, type EvaluationPorts } from "./foundry-ports.ts";
import { assessmentSubmit } from "./step-assessment-submit.ts";
import { assetsPlace } from "./step-assets-place.ts";
import { envSetupReview } from "./step-env-setup-host.ts";
import { inputsReadEvaluation } from "./step-inputs-read-host.ts";
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

function evaluationTasks(): ChainTasks<EvaluationPorts> {
  const nodes = evaluationTasksNodes();
  return {
    name: "foundryEvaluation",
    ports: EVALUATION_PORTS,
    nodes,
    async run(ctx, control, host) {
      const end = await runEvaluationTasks(
        nodes,
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
          dependencies: ctx.dependencies,
        },
        host,
      );
      Object.assign(ctx, end.result);
      return end;
    },
  };
}

export function evaluationChain(): Chain<EvaluationPorts> {
  return chain<EvaluationPorts>(ChainId.Evaluation, EVALUATION_PORTS)
    .phase(Phase.Prepare)
    .step(inputsReadEvaluation)
    .nodes(evaluationPrepareNodes())
    .tasks(evaluationTasks())
    .phase(Phase.Finish)
    .step(assessmentSubmit)
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.AssessmentAbsent })
    .build();
}
