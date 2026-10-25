import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
import { UnmetGround } from "./judgement.ts";
import { VerificationClass } from "./verification.ts";
import {
  EvaluationStage,
  reworkCauseOf,
  type EvaluationFacts,
} from "./rework-cause.ts";

function facts(overrides: Partial<EvaluationFacts>): EvaluationFacts {
  return {
    stage: EvaluationStage.Judgement,
    unmet_ids: [],
    unmet_grounds: [],
    proposal_count: 0,
    repaired: false,
    verification_class: VerificationClass.Pass,
    ...overrides,
  };
}

test("the setup stage is unattributed with the suspects environment and model", () => {
  assert.deepEqual(
    reworkCauseOf(
      facts({
        stage: EvaluationStage.Setup,
        repaired: null,
        verification_class: VerificationClass.CodeFailure,
      }),
    ),
    {
      category: CauseCategory.Unattributed,
      assigner: CauseAssigner.Rule,
      suspects: [CauseCategory.Environment, CauseCategory.Model],
    },
  );
});

test("a failed verification of the class code_failure is unattributed with the suspects model and plan", () => {
  assert.deepEqual(
    reworkCauseOf(
      facts({
        stage: EvaluationStage.Verification,
        repaired: null,
        verification_class: VerificationClass.CodeFailure,
      }),
    ),
    {
      category: CauseCategory.Unattributed,
      assigner: CauseAssigner.Rule,
      suspects: [CauseCategory.Model, CauseCategory.Plan],
    },
  );
});

test("a judgement decides by its first unmet ground", () => {
  const cases = [
    [UnmetGround.Stated, CauseCategory.Model, CauseSubcategory.WorkDefect],
    [
      UnmetGround.Standard,
      CauseCategory.Model,
      CauseSubcategory.StandardViolation,
    ],
    [
      UnmetGround.Unstated,
      CauseCategory.Plan,
      CauseSubcategory.CriterionUnstated,
    ],
  ] as const;
  for (const [ground, category, subcategory] of cases)
    assert.deepEqual(
      reworkCauseOf(facts({ unmet_ids: ["a"], unmet_grounds: [ground] })),
      { category, subcategory, assigner: CauseAssigner.Reviewer },
    );
});

test("the first unmet ground decides over a later one", () => {
  assert.deepEqual(
    reworkCauseOf(
      facts({
        unmet_ids: ["a", "b"],
        unmet_grounds: [UnmetGround.Standard, UnmetGround.Stated],
      }),
    ),
    {
      category: CauseCategory.Model,
      subcategory: CauseSubcategory.StandardViolation,
      assigner: CauseAssigner.Reviewer,
    },
  );
});

test("any other facts are unattributed with no suspects", () => {
  const expected = {
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [],
  };
  assert.deepEqual(reworkCauseOf(facts({})), expected);
  assert.deepEqual(
    reworkCauseOf(
      facts({
        stage: EvaluationStage.Verification,
        repaired: null,
        verification_class: VerificationClass.Environment,
      }),
    ),
    expected,
  );
});
