import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
} from "../../kernel/cause.ts";
import { AffectedVerdict } from "./affected.ts";
import { judgementBlockers, UnmetGround } from "./judgement.ts";
import { type Finding, FindingKind } from "../../mission/contract.ts";
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
    round: 1,
    final_round: false,
    action_labels: [],
    fixed_count: 0,
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

function finding(
  id: string,
  label: string,
  ground: UnmetGround | null,
  taskId: string | null = null,
) {
  return {
    label,
    action: "yes" as const,
    task_id: taskId,
    ground,
    name: `name ${id}`,
    description: `defect ${id}`,
    fix: `fix ${id}`,
    why: `why ${id}`,
  };
}

function priorFinding(
  id: string,
  label: string,
  ground: UnmetGround | null,
): Finding {
  return {
    ...finding(id, label, ground),
    id,
    node_id: "node",
    attempt: 1,
    round: 1,
    assessment_id: "assessment",
    source: "reviewer",
    kind: ground === null ? FindingKind.Suggestion : FindingKind.Blocker,
    route: "fix",
    status: "open",
    fixed_assessment_id: null,
    cause_owner: null,
    created_by: null,
    created_at: 0,
    decision: null,
    decision_reason: null,
    decided_by: null,
    decided_at: null,
  } as Finding;
}

test("the blocker findings of a judgement give one cause per row", () => {
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
  for (const [ground, category, subcategory] of cases) {
    const blockers = judgementBlockers(
      "node",
      {
        findings: [
          finding("s", "S1", null),
          finding("b", "B1", ground, "task"),
        ],
        fixed_finding_ids: [],
      },
      [],
    );
    assert.deepEqual(
      reworkCauseOf(
        facts({
          unmet_ids: blockers.map((item) => item.id),
          unmet_grounds: blockers.map((item) => item.ground),
        }),
      ),
      { category, subcategory, assigner: CauseAssigner.Reviewer },
    );
  }
});

test("an unlisted prior blocker gives its ground to the cause and a listed one does not", () => {
  const prior = [
    priorFinding("finding_listed", "B1", UnmetGround.Unstated),
    priorFinding("finding_open", "B2", UnmetGround.Conflict),
    priorFinding("finding_suggestion", "S1", null),
  ];
  const blockers = judgementBlockers(
    "node",
    {
      findings: [finding("b", "B1", UnmetGround.Stated)],
      fixed_finding_ids: ["finding_listed"],
    },
    prior,
  );
  assert.deepEqual(blockers, [
    { id: "node", reason: "defect b", ground: UnmetGround.Stated },
    { id: "node", reason: "defect finding_open", ground: UnmetGround.Conflict },
  ]);
  assert.deepEqual(
    reworkCauseOf(
      facts({
        unmet_ids: blockers.map((item) => item.id),
        unmet_grounds: blockers.map((item) => item.ground),
      }),
    ),
    {
      category: CauseCategory.Plan,
      subcategory: CauseSubcategory.RequirementConflict,
      assigner: CauseAssigner.Reviewer,
    },
  );
});
