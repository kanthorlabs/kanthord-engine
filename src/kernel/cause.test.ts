import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributed,
  CAUSE_SUBCATEGORIES,
  CauseAssigner,
  CauseAttribute,
  CauseCategory,
  causeAttributes,
  CauseSubcategory,
  effectiveCauseSchema,
  failureCauseSchema,
  unattributed,
} from "./cause.ts";

const SUBCATEGORY_COUNT = 36;
const EXPECTED_SUBCATEGORIES = {
  prompt: ["context_missing", "instruction_conflict", "rule_absent"],
  plan: [
    "criterion_unstated",
    "dependency",
    "verification_context",
    "verification_insufficient",
    "decomposition",
    "oversized",
  ],
  worker_action: [
    "gate_commit",
    "merge_base",
    "release_gate",
    "review_flow",
    "step_failed",
  ],
  llm_provider: ["rate_limited", "quota_exhausted", "unavailable"],
  model: [
    "work_defect",
    "standard_violation",
    "verification_failed",
    "no_progress",
    "reply_invalid",
    "protocol_violation",
    "output_truncated",
    "budget_exhausted",
    "judgement_wrong",
  ],
  environment: [
    "setup_failed",
    "command_absent",
    "flaky_verification",
    "verification_hang",
    "repository_hook",
  ],
  infrastructure: ["verification_killed", "network", "execution_lost"],
  human: ["intervention", "configuration"],
  unattributed: [],
};

test("every category maps to its subcategories", () => {
  assert.deepEqual(CAUSE_SUBCATEGORIES, EXPECTED_SUBCATEGORIES);
  assert.equal(Object.keys(CauseSubcategory).length, SUBCATEGORY_COUNT);
  const mapped = Object.values(CAUSE_SUBCATEGORIES).flat();
  assert.deepEqual([...mapped].sort(), Object.values(CauseSubcategory).sort());
});

test("the schema accepts an attributed and an unattributed cause", () => {
  const attributedCause = {
    category: CauseCategory.Model,
    assigner: CauseAssigner.Reviewer,
    subcategory: CauseSubcategory.WorkDefect,
  };
  const unattributedCause = {
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Human,
    suspects: [],
  };
  assert.ok(effectiveCauseSchema.safeParse(attributedCause).success);
  assert.ok(effectiveCauseSchema.safeParse(unattributedCause).success);
});

test("the schema refuses a subcategory of another category", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Model,
    assigner: CauseAssigner.Rule,
    subcategory: CauseSubcategory.Network,
  });
  assert.equal(result.success, false);
});

test("the schema refuses an attributed cause with no subcategory", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Model,
    assigner: CauseAssigner.Rule,
  });
  assert.equal(result.success, false);
});

test("the schema refuses a subcategory on unattributed", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    subcategory: CauseSubcategory.Network,
    suspects: [],
  });
  assert.equal(result.success, false);
});

test("the schema refuses an unattributed cause with no suspects", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
  });
  assert.equal(result.success, false);
});

test("the schema refuses a suspect unattributed", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [CauseCategory.Unattributed],
  });
  assert.equal(result.success, false);
});

test("the schema refuses a repeated suspect", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Unattributed,
    assigner: CauseAssigner.Rule,
    suspects: [CauseCategory.Model, CauseCategory.Model],
  });
  assert.equal(result.success, false);
});

test("the schema refuses suspects on an attributed cause", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Model,
    assigner: CauseAssigner.Rule,
    subcategory: CauseSubcategory.WorkDefect,
    suspects: [CauseCategory.Plan],
  });
  assert.equal(result.success, false);
});

test("the failure cause refuses the assigner human", () => {
  const cause = {
    category: CauseCategory.Human,
    assigner: CauseAssigner.Human,
    subcategory: CauseSubcategory.Intervention,
  };
  assert.ok(effectiveCauseSchema.safeParse(cause).success);
  assert.equal(failureCauseSchema.safeParse(cause).success, false);
});

test("causeAttributes omits an absent subcategory and empty suspects", () => {
  assert.deepEqual(causeAttributes(unattributed([])), {
    [CauseAttribute.Category]: "unattributed",
    [CauseAttribute.Assigner]: "rule",
  });
});

test("causeAttributes answers the subcategory and the suspects", () => {
  assert.deepEqual(
    causeAttributes(
      attributed(CauseCategory.Model, CauseSubcategory.NoProgress),
    ),
    {
      [CauseAttribute.Category]: "model",
      [CauseAttribute.Assigner]: "rule",
      [CauseAttribute.Subcategory]: "no_progress",
    },
  );
  assert.deepEqual(
    causeAttributes(unattributed([CauseCategory.Plan, CauseCategory.Model])),
    {
      [CauseAttribute.Category]: "unattributed",
      [CauseAttribute.Assigner]: "rule",
      [CauseAttribute.Suspects]: ["plan", "model"],
    },
  );
});

test("attributed uses the assigner rule by default", () => {
  const cause = attributed(CauseCategory.Plan, CauseSubcategory.Oversized);
  assert.equal(cause.assigner, CauseAssigner.Rule);
  assert.throws(() => attributed(CauseCategory.Plan, CauseSubcategory.Network));
});
