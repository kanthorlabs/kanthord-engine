import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
  unattributed,
  type FailureCause,
} from "../../kernel/cause.ts";
import { UnmetGround } from "./judgement.ts";
import type { AffectedVerdict } from "./affected.ts";
import { VerificationClass } from "./verification.ts";

export const EvaluationStage = {
  Setup: "setup",
  Verification: "verification",
  Affected: "affected",
  Judgement: "judgement",
} as const;
export type EvaluationStage =
  (typeof EvaluationStage)[keyof typeof EvaluationStage];

export interface EvaluationFacts {
  stage: EvaluationStage;
  unmet_ids: string[];
  unmet_grounds: UnmetGround[];
  proposal_count: number;
  repaired: boolean | null;
  verification_class: VerificationClass;
  affected: AffectedVerdict | null;
}

const GROUND_CAUSES: Readonly<
  Record<UnmetGround, [CauseCategory, CauseSubcategory]>
> = {
  [UnmetGround.Stated]: [CauseCategory.Model, CauseSubcategory.WorkDefect],
  [UnmetGround.Standard]: [
    CauseCategory.Model,
    CauseSubcategory.StandardViolation,
  ],
  [UnmetGround.Unstated]: [
    CauseCategory.Plan,
    CauseSubcategory.CriterionUnstated,
  ],
};

export function reworkCauseOf(facts: EvaluationFacts): FailureCause {
  if (facts.stage === EvaluationStage.Setup)
    return unattributed([CauseCategory.Environment, CauseCategory.Model]);
  if (
    facts.stage === EvaluationStage.Verification &&
    facts.verification_class === VerificationClass.CodeFailure
  )
    return unattributed([CauseCategory.Model, CauseCategory.Plan]);
  if (facts.stage === EvaluationStage.Affected)
    return unattributed([CauseCategory.Model, CauseCategory.Plan]);
  const ground = facts.unmet_grounds[0];
  if (facts.stage !== EvaluationStage.Judgement || ground === undefined)
    return unattributed([]);
  const [category, subcategory] = GROUND_CAUSES[ground];
  return attributed(category, subcategory, CauseAssigner.Reviewer);
}
