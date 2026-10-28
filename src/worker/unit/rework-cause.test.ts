import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
import { AffectedVerdict } from "./affected.ts";
import { UnmetGround } from "./judgement.ts";
import { VerificationClass } from "./verification.ts";
import {
  type EvaluationFacts,
  EvaluationStage,
  reworkCauseOf,
} from "./rework-cause.ts";

function facts(overrides: Partial<EvaluationFacts>): EvaluationFacts {
  return {
    stage: EvaluationStage.Judgement,
    unmet_ids: [],
    unmet_grounds: [],
    proposal_count: 0,
    repaired: false,
    verification_class: VerificationClass.Pass,
    affected: null,
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
    [
      UnmetGround.Conflict,
      CauseCategory.Plan,
      CauseSubcategory.RequirementConflict,
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

test("a plan ground decides over a stated or standard ground in any position", () => {
  const cases = [
    [
      [UnmetGround.Stated, UnmetGround.Unstated],
      CauseSubcategory.CriterionUnstated,
    ],
    [
      [UnmetGround.Standard, UnmetGround.Stated, UnmetGround.Conflict],
      CauseSubcategory.RequirementConflict,
    ],
    [
      [UnmetGround.Unstated, UnmetGround.Conflict],
      CauseSubcategory.RequirementConflict,
    ],
  ] as const;
  for (const [grounds, subcategory] of cases)
    assert.deepEqual(
      reworkCauseOf(
        facts({
          unmet_ids: grounds.map((_, index) => `item_${index}`),
          unmet_grounds: [...grounds],
        }),
      ),
      {
        category: CauseCategory.Plan,
        subcategory,
        assigner: CauseAssigner.Reviewer,
      },
    );
});

test("the affected stage is unattributed with the suspects model and plan", () => {
  assert.deepEqual(
    reworkCauseOf(
      facts({
        stage: EvaluationStage.Affected,
        repaired: null,
        affected: AffectedVerdict.Failed,
      }),
    ),
    {
      category: CauseCategory.Unattributed,
      assigner: CauseAssigner.Rule,
      suspects: [CauseCategory.Model, CauseCategory.Plan],
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
