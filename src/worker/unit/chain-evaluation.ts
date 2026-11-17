import {
  BudgetEndKind,
  chain,
  type Chain,
  ChainId,
  type ChainNode,
  FrameOutcome,
  type LoopFrame,
  stepNode,
} from "./chain.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import { EndReason } from "./execution-stop.ts";
import {
  evaluationEnd,
  evaluationSpan,
  testedCommitOf,
} from "./method-telemetry.ts";
import { affectedRunEvaluation } from "./step-affected-run.ts";
import { assessmentSubmit } from "./step-assessment-submit.ts";
import { assetsPlace } from "./step-assets-place.ts";
import { envSetupReview } from "./step-env-setup.ts";
import {
  evidencePublishAffected,
  evidencePublishPatches,
  evidencePublishVerification,
} from "./step-evidence-publish.ts";
import {
  inputsReadAttemptEvidence,
  inputsReadDependenciesEvaluation,
  inputsReadReviewRound,
  inputsReadRevision,
} from "./step-inputs-read.ts";
import { judgement } from "./step-judgement.ts";
import { setupEntriesReview } from "./step-setup-entries.ts";
import { verifyAllEvaluation } from "./step-verify-all.ts";
import { workspaceReviewSnapshot } from "./step-workspace-review.ts";
import { Phase } from "./telemetry.ts";

const ONE_FRAME = true;

export function evaluationPrepareNodes(): ChainNode[] {
  return [
    stepNode(workspaceReviewSnapshot),
    stepNode(setupEntriesReview),
    stepNode(envSetupReview),
    stepNode(assetsPlace),
  ];
}

const evaluationFrame: LoopFrame<true> = {
  reads: ["testedInput"],
  endReads: ["judgement"],
  note: "one frame; span worker.evaluation",
  init: () => ONE_FRAME,
  body: [
    stepNode(verifyAllEvaluation),
    stepNode(evidencePublishVerification),
    stepNode(affectedRunEvaluation),
    stepNode(evidencePublishAffected),
    stepNode(inputsReadDependenciesEvaluation),
    stepNode(judgement),
    stepNode(evidencePublishPatches),
  ],
  next: () => null,
  span: (ctx, _scope, spans) =>
    evaluationSpan(spans, testedCommitOf(ctx.testedInput)),
  end: (ctx, _scope, ended) =>
    ended.outcome === FrameOutcome.Next
      ? evaluationEnd(ctx.judgement)
      : { status: SpanStatus.Error },
};

export function evaluationChain(): Chain {
  return chain(ChainId.Evaluation)
    .phase(Phase.Prepare)
    .step(inputsReadRevision)
    .step(inputsReadAttemptEvidence)
    .step(inputsReadReviewRound)
    .nodes(evaluationPrepareNodes())
    .phase(Phase.Tasks)
    .loop("evaluation", evaluationFrame)
    .phase(Phase.Finish)
    .step(assessmentSubmit)
    .budgetEnd({ kind: BudgetEndKind.Stop, reason: EndReason.AssessmentAbsent })
    .build();
}
