import { AssessmentResult, NodeState } from "../../mission/contract.ts";
import {
  DeadlineKind,
  type ExecutionCtx,
  type Step,
  StepKind,
} from "./chain.ts";
import { requestAndRelease } from "./evaluation.ts";
import { EndReason, ExecutionEndKind } from "./execution-stop.ts";
import { reworkCauseOf } from "./rework-cause.ts";

export const assessmentSubmit: Step<
  unknown,
  | "claim"
  | "judgement"
  | "verificationEvidence"
  | "affectedEvidence"
  | "patchEvidence"
  | "placed"
  | "dependencies"
  | "testedInput",
  "end"
> = {
  id: "assessment.submit",
  deadline: DeadlineKind.Cleanup,
  reads: [
    "claim",
    "judgement",
    "verificationEvidence",
    "affectedEvidence",
    "patchEvidence",
    "placed",
    "dependencies",
    "testedInput",
  ],
  writes: ["end"],
  stops: ["operation_failed", "action_unsettled"],
  note: "outcome -> closed; node not Evaluating -> revoked; success -> request actions, then execution.release(false)",
  async run(ctx, scope, io) {
    const assessment = ctx.judgement;
    const closed = (end: ExecutionCtx["end"]) => ({
      kind: StepKind.Closed,
      patch: { end },
      scope,
    });
    const answer = await io.run.submitAssessment(ctx.claim.node_id, {
      evidence_ids: [
        ctx.verificationEvidence,
        ...(ctx.affectedEvidence === null ? [] : [ctx.affectedEvidence]),
        ...ctx.patchEvidence,
        ...ctx.placed.evidenceIds,
      ],
      dependency_outcome_ids:
        ctx.dependencies?.outcomes.map((outcome) => outcome.id) ?? [],
      result: assessment.result,
      rationale: assessment.rationale,
      proposals: assessment.proposals,
      findings: assessment.findings,
      fixed_finding_ids: assessment.fixed_finding_ids,
      tested_input: ctx.testedInput,
      ...(assessment.result === AssessmentResult.CriterionNotMet
        ? { cause: reworkCauseOf(assessment.facts) }
        : {}),
    });
    if (answer.outcome)
      return closed({
        kind: ExecutionEndKind.Closed,
        outcomeId: answer.outcome.id,
      });
    if (!("state" in answer.node && answer.node.state === NodeState.Evaluating))
      return closed({
        kind: ExecutionEndKind.Ended,
        reason: EndReason.Revoked,
        code: null,
      });
    if (answer.assessment.result === AssessmentResult.Success)
      return closed(await requestAndRelease(io.run));
    return io.run.stop(EndReason.OperationFailed);
  },
};
