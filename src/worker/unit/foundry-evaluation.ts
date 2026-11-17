import { SpanStatus } from "../../tracking/contract.ts";
import {
  type ChainNode,
  type ExecutionCtx,
  type FoundryEnd,
  FrameOutcome,
  type LoopFrame,
  loopNode,
  stepNode,
} from "./chain.ts";
import type { EvaluationPorts } from "./foundry-ports.ts";
import {
  type FoundryControl,
  type FoundryHost,
  pickKeys,
  runTasks,
} from "./foundry.ts";
import {
  evaluationEnd,
  evaluationSpan,
  testedCommitOf,
} from "./method-telemetry.ts";
import { affectedRunEvaluation } from "./step-affected-run.ts";
import {
  evidencePublishAffected,
  evidencePublishPatches,
  evidencePublishVerification,
} from "./step-evidence-publish.ts";
import { inputsReadDependenciesEvaluation } from "./step-inputs-read.ts";
import { judgement } from "./step-judgement.ts";
import { verifyAllEvaluation } from "./step-verify-all.ts";

const ONE_FRAME = true;

export const EVALUATION_INPUT_KEYS = [
  "claim",
  "setup",
  "revision",
  "reviewWorkspace",
  "testedInput",
  "baseHead",
  "setupFailure",
  "placed",
  "reviewRound",
] as const;
export const EVALUATION_RESULT_KEYS = [
  "verification",
  "affected",
  "verificationEvidence",
  "affectedEvidence",
  "patchEvidence",
  "dependencies",
  "judgement",
] as const;

export interface EvaluationInput
  extends
    FoundryControl,
    Pick<ExecutionCtx, (typeof EVALUATION_INPUT_KEYS)[number]> {}

export type EvaluationResult = Partial<
  Pick<ExecutionCtx, (typeof EVALUATION_RESULT_KEYS)[number]>
>;

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

export function evaluationTasksNodes(): ChainNode[] {
  return [loopNode("evaluation", evaluationFrame)];
}

export function foundryEvaluation(
  input: EvaluationInput,
  host: FoundryHost<EvaluationPorts>,
): Promise<FoundryEnd<EvaluationResult>> {
  return runEvaluationTasks(evaluationTasksNodes(), input, host);
}

export function runEvaluationTasks(
  nodes: readonly ChainNode[],
  input: EvaluationInput,
  host: FoundryHost<EvaluationPorts>,
): Promise<FoundryEnd<EvaluationResult>> {
  return runTasks(
    {
      nodes,
      seed: pickKeys(input, EVALUATION_INPUT_KEYS),
      resultOf: (ctx) => pickKeys(ctx, EVALUATION_RESULT_KEYS),
    },
    input,
    host,
  );
}
