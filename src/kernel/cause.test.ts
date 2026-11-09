import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attributed,
  CauseAssigner,
  CauseCategory,
  CauseSubcategory,
  effectiveCauseSchema,
  failureCauseSchema,
} from "./cause.ts";

test("the schema refuses a subcategory of another category", () => {
  const result = effectiveCauseSchema.safeParse({
    category: CauseCategory.Model,
    assigner: CauseAssigner.Rule,
    subcategory: CauseSubcategory.Network,
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

test("attributed uses the assigner rule by default", () => {
  const cause = attributed(CauseCategory.Plan, CauseSubcategory.Oversized);
  assert.equal(cause.assigner, CauseAssigner.Rule);
  assert.throws(() => attributed(CauseCategory.Plan, CauseSubcategory.Network));
});
