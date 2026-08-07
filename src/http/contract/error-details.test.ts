import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  bindingInUseDetails,
  choicesChangedDetails,
  choicesInvalidDetails,
  choicesStaleDetails,
  credentialRejectedDetails,
  hostKeyMismatchDetails,
  idempotencyMismatchDetails,
  invalidRequestDetails,
  needsReconcileDetails,
  planInvalidDetails,
  staleRevisionDetails,
} from "./error-details.ts";

describe("src/http/contract/error-details.test", () => {
  describe("staleRevisionDetails", () => {
    it("parses expected and current as strings", () => {
      const parsed = staleRevisionDetails.parse({
        expected: "revision_a",
        current: "revision_b",
      });
      assert.deepEqual(parsed, {
        expected: "revision_a",
        current: "revision_b",
      });
    });

    it("parses both fields null", () => {
      const parsed = staleRevisionDetails.parse({
        expected: null,
        current: null,
      });
      assert.deepEqual(parsed, { expected: null, current: null });
    });

    it("rejects a missing expected", () => {
      assert.throws(() => staleRevisionDetails.parse({ current: "x" }));
    });

    it("rejects an unknown key", () => {
      assert.throws(() =>
        staleRevisionDetails.parse({ expected: "a", current: "b", extra: 1 }),
      );
    });
  });

  describe("needsReconcileDetails", () => {
    const oidA = "a".repeat(40);
    const oidB = "b".repeat(40);

    it("parses two 40-character hex ids", () => {
      const parsed = needsReconcileDetails.parse({
        divergedLandingOid: oidA,
        divergedUpstreamOid: oidB,
      });
      assert.deepEqual(parsed, {
        divergedLandingOid: oidA,
        divergedUpstreamOid: oidB,
      });
    });

    it("rejects a null", () => {
      assert.throws(() =>
        needsReconcileDetails.parse({
          divergedLandingOid: null,
          divergedUpstreamOid: oidB,
        }),
      );
    });

    it("rejects a 39-character id", () => {
      assert.throws(() =>
        needsReconcileDetails.parse({
          divergedLandingOid: "a".repeat(39),
          divergedUpstreamOid: oidB,
        }),
      );
    });
  });

  describe("bindingInUseDetails", () => {
    it("parses one blocker of each of the three kinds", () => {
      for (const blocker of [
        { kind: "default-chain" },
        { kind: "project-binding", projectId: "project_a" },
        { kind: "repository", repositoryId: "repository_a" },
      ]) {
        const parsed = bindingInUseDetails.parse({ blockers: [blocker] });
        assert.deepEqual(parsed, { blockers: [blocker] });
      }
    });

    it("rejects an empty blocker list", () => {
      assert.throws(() => bindingInUseDetails.parse({ blockers: [] }));
    });

    it("rejects a project-binding blocker missing projectId", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({
          blockers: [{ kind: "project-binding" }],
        }),
      );
    });

    it("rejects an unknown blocker kind", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({ blockers: [{ kind: "nope" }] }),
      );
    });
  });

  describe("choicesStaleDetails and choicesChangedDetails", () => {
    it("choicesStaleDetails parses a conflict carrying suggested", () => {
      const parsed = choicesStaleDetails.parse({
        conflicts: [{ id: "x", suggested: "submitted" }],
      });
      assert.deepEqual(parsed, {
        conflicts: [{ id: "x", suggested: "submitted" }],
      });
    });

    it("choicesStaleDetails rejects the choices-changed shape", () => {
      assert.throws(() =>
        choicesStaleDetails.parse({ conflicts: [{ id: "x", reason: "y" }] }),
      );
    });

    it("choicesChangedDetails parses a conflict carrying reason", () => {
      const parsed = choicesChangedDetails.parse({
        conflicts: [{ id: "x", reason: "y" }],
      });
      assert.deepEqual(parsed, { conflicts: [{ id: "x", reason: "y" }] });
    });

    it("choicesChangedDetails rejects the choices-stale shape", () => {
      assert.throws(() =>
        choicesChangedDetails.parse({
          conflicts: [{ id: "x", suggested: "submitted" }],
        }),
      );
    });
  });

  describe("planInvalidDetails and choicesInvalidDetails", () => {
    const finding = {
      code: "path-invalid",
      path: "plan/i--01/01-a.md",
      id: null,
      message: "the path is not legal",
    };

    it("planInvalidDetails parses one real Finding", () => {
      const parsed = planInvalidDetails.parse({ findings: [finding] });
      assert.deepEqual(parsed, { findings: [finding] });
    });

    it("planInvalidDetails rejects a finding missing required fields", () => {
      assert.throws(() => planInvalidDetails.parse({ findings: [{}] }));
    });

    it("choicesInvalidDetails parses one real Finding", () => {
      const parsed = choicesInvalidDetails.parse({ findings: [finding] });
      assert.deepEqual(parsed, { findings: [finding] });
    });
  });

  describe("hostKeyMismatchDetails", () => {
    it("parses the presented/confirmed member", () => {
      const parsed = hostKeyMismatchDetails.parse({
        presented: ["SHA256:aaaa"],
        confirmed: null,
      });
      assert.deepEqual(parsed, { presented: ["SHA256:aaaa"], confirmed: null });
    });

    it("parses the failure member", () => {
      const parsed = hostKeyMismatchDetails.parse({
        failure: "host-key-mismatch",
      });
      assert.deepEqual(parsed, { failure: "host-key-mismatch" });
    });

    it("rejects an unrelated failure value", () => {
      assert.throws(() =>
        hostKeyMismatchDetails.parse({ failure: "auth-failed" }),
      );
    });

    it("rejects a merge of both members", () => {
      assert.throws(() =>
        hostKeyMismatchDetails.parse({
          presented: [],
          confirmed: null,
          failure: "host-key-mismatch",
        }),
      );
    });
  });

  describe("credentialRejectedDetails", () => {
    it("parses both failures", () => {
      assert.deepEqual(
        credentialRejectedDetails.parse({ failure: "auth-failed" }),
        { failure: "auth-failed" },
      );
      assert.deepEqual(
        credentialRejectedDetails.parse({ failure: "permission-denied" }),
        { failure: "permission-denied" },
      );
    });

    it("rejects an unrelated failure string", () => {
      assert.throws(() => credentialRejectedDetails.parse({ failure: "nope" }));
    });
  });

  describe("idempotencyMismatchDetails", () => {
    it("parses differed", () => {
      assert.deepEqual(
        idempotencyMismatchDetails.parse({ differed: "documents" }),
        { differed: "documents" },
      );
    });
  });

  describe("invalidRequestDetails", () => {
    it("parses refusal alone", () => {
      assert.deepEqual(invalidRequestDetails.parse({ refusal: "name-taken" }), {
        refusal: "name-taken",
      });
    });

    it("parses refusal with detail", () => {
      assert.deepEqual(
        invalidRequestDetails.parse({ refusal: "x", detail: "y" }),
        { refusal: "x", detail: "y" },
      );
    });

    it("parses refusal with ids", () => {
      assert.deepEqual(
        invalidRequestDetails.parse({ refusal: "choice-missing", ids: ["a"] }),
        { refusal: "choice-missing", ids: ["a"] },
      );
    });

    it("rejects an empty object", () => {
      assert.throws(() => invalidRequestDetails.parse({}));
    });
  });
});
