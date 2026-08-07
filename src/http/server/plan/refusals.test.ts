import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHttpError } from "./refusals.ts";
import { ImportPlanError } from "../../../commands/plan/import-plan.ts";
import type { ImportPlanRefusal } from "../../../commands/plan/import-plan.ts";
import {
  choicesChangedDetails,
  choicesInvalidDetails,
  choicesStaleDetails,
  idempotencyMismatchDetails,
  invalidRequestDetails,
  planInvalidDetails,
  staleRevisionDetails,
} from "../../contract/error-details.ts";
import { baselineErrors } from "../../contract/error-baseline.ts";
import { findOperation } from "../../contract/registry.ts";

const everyImportPlanRefusal: Readonly<Record<ImportPlanRefusal, true>> = {
  "project-not-found": true,
  "plan-invalid": true,
  "choices-invalid": true,
  "choices-stale": true,
  "choices-changed": true,
  "stale-revision": true,
  "idempotency-mismatch": true,
  "documents-hash-mismatch": true,
  "choice-duplicate": true,
  "choice-missing": true,
  "choice-extra": true,
};

const finding = {
  code: "path-invalid",
  path: "plan/i--01/01-a.md",
  id: null,
  message: "the path is not legal",
};

describe("src/http/server/plan/refusals.test", () => {
  it("plan-invalid details satisfy planInvalidDetails", () => {
    const error = toHttpError(
      new ImportPlanError(
        "plan-invalid",
        "the submission is not a valid plan",
        {
          findings: [finding],
        },
      ),
    );
    assert.equal(error.code, "plan-invalid");
    assert.doesNotThrow(() => planInvalidDetails.parse(error.details));
  });

  it("choices-invalid details satisfy choicesInvalidDetails", () => {
    const error = toHttpError(
      new ImportPlanError(
        "choices-invalid",
        "the chosen set builds an invalid graph",
        { findings: [finding] },
      ),
    );
    assert.equal(error.code, "choices-invalid");
    assert.doesNotThrow(() => choicesInvalidDetails.parse(error.details));
  });

  it("choices-stale details satisfy choicesStaleDetails", () => {
    const error = toHttpError(
      new ImportPlanError("choices-stale", "the choices moved", {
        conflicts: [{ id: "task_a", suggested: "submitted" }],
      }),
    );
    assert.equal(error.code, "choices-stale");
    assert.doesNotThrow(() => choicesStaleDetails.parse(error.details));
  });

  it("choices-changed details satisfy choicesChangedDetails", () => {
    const error = toHttpError(
      new ImportPlanError(
        "choices-changed",
        "a selected outcome is no longer legal",
        { conflicts: [{ id: "task_a", reason: "held" }] },
      ),
    );
    assert.equal(error.code, "choices-changed");
    assert.doesNotThrow(() => choicesChangedDetails.parse(error.details));
  });

  it("stale-revision details satisfy staleRevisionDetails", () => {
    const error = toHttpError(
      new ImportPlanError("stale-revision", "the import is stale", {
        expected: "revision_a",
        current: "revision_b",
      }),
    );
    assert.equal(error.code, "stale-revision");
    assert.doesNotThrow(() => staleRevisionDetails.parse(error.details));
  });

  it("idempotency-mismatch details satisfy idempotencyMismatchDetails", () => {
    const error = toHttpError(
      new ImportPlanError(
        "idempotency-mismatch",
        "the documents differ from the committed import",
        { differed: "documents" },
      ),
    );
    assert.equal(error.code, "idempotency-mismatch");
    assert.doesNotThrow(() => idempotencyMismatchDetails.parse(error.details));
  });

  it("documents-hash-mismatch maps to invalid-request and satisfies invalidRequestDetails", () => {
    const error = toHttpError(
      new ImportPlanError(
        "documents-hash-mismatch",
        "the documents hash does not match the validated submission",
      ),
    );
    assert.equal(error.code, "invalid-request");
    assert.doesNotThrow(() => invalidRequestDetails.parse(error.details));
  });

  it("choice-duplicate, choice-missing and choice-extra map to invalid-request and satisfy invalidRequestDetails", () => {
    for (const refusal of [
      "choice-duplicate",
      "choice-missing",
      "choice-extra",
    ] as const) {
      const error = toHttpError(
        new ImportPlanError(refusal, "the choice set is not legal", {
          ids: ["task_a"],
        }),
      );
      assert.equal(error.code, "invalid-request");
      assert.doesNotThrow(() => invalidRequestDetails.parse(error.details));
    }
  });

  it("the codes toHttpError can emit beyond the baseline equal plan.import's declared additions", () => {
    const baselineCodes = new Set(Object.keys(baselineErrors));
    const collected = new Set<string>();

    for (const refusal of Object.keys(
      everyImportPlanRefusal,
    ) as ImportPlanRefusal[]) {
      try {
        collected.add(toHttpError(new ImportPlanError(refusal, "x")).code);
      } catch {}
    }

    const extras = [...collected]
      .filter((code) => !baselineCodes.has(code))
      .sort();

    const entry = findOperation("plan.import");
    assert.ok(entry?.errors !== undefined, "plan.import declares no errors");
    const declaredExtras = Object.keys(entry.errors)
      .filter((code) => !baselineCodes.has(code))
      .sort();

    assert.deepEqual(extras, declaredExtras);
  });
});
