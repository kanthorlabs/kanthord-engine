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
  illegalTransitionDetails,
  invalidRequestDetails,
  needsReconcileDetails,
  planInvalidDetails,
  staleRevisionDetails,
} from "./error-details.ts";

describe("src/http/contract/error-details.test", () => {
  describe("staleRevisionDetails", () => {
    it("parses guard, expected and actual as strings", () => {
      const parsed = staleRevisionDetails.parse({
        guard: "project",
        expected: "revision_a",
        actual: "revision_b",
      });
      assert.deepEqual(parsed, {
        guard: "project",
        expected: "revision_a",
        actual: "revision_b",
      });
    });

    it("parses the node guard", () => {
      const parsed = staleRevisionDetails.parse({
        guard: "node",
        expected: "revision_a",
        actual: "revision_b",
      });
      assert.deepEqual(parsed, {
        guard: "node",
        expected: "revision_a",
        actual: "revision_b",
      });
    });

    it("parses both revision fields null", () => {
      const parsed = staleRevisionDetails.parse({
        guard: "project",
        expected: null,
        actual: null,
      });
      assert.deepEqual(parsed, {
        guard: "project",
        expected: null,
        actual: null,
      });
    });

    it("rejects a missing expected", () => {
      assert.throws(() =>
        staleRevisionDetails.parse({ guard: "project", actual: "x" }),
      );
    });

    it("rejects a missing guard", () => {
      assert.throws(() =>
        staleRevisionDetails.parse({ expected: "a", actual: "b" }),
      );
    });

    it("rejects an unknown guard value", () => {
      assert.throws(() =>
        staleRevisionDetails.parse({
          guard: "plan",
          expected: "a",
          actual: "b",
        }),
      );
    });

    it("rejects the pre-epic current member and an unknown key", () => {
      assert.throws(() =>
        staleRevisionDetails.parse({
          guard: "project",
          expected: "a",
          current: "b",
        }),
      );
      assert.throws(() =>
        staleRevisionDetails.parse({
          guard: "project",
          expected: "a",
          actual: "b",
          extra: 1,
        }),
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
    it("parses one nodeId and blocker pair", () => {
      const parsed = bindingInUseDetails.parse({
        blockers: [{ nodeId: "task_a", blocker: "workspace" }],
      });
      assert.deepEqual(parsed, {
        blockers: [{ nodeId: "task_a", blocker: "workspace" }],
      });
    });

    it("parses several pairs", () => {
      const parsed = bindingInUseDetails.parse({
        blockers: [
          { nodeId: "task_a", blocker: "run" },
          { nodeId: "task_a", blocker: "attempt" },
        ],
      });
      assert.deepEqual(parsed, {
        blockers: [
          { nodeId: "task_a", blocker: "run" },
          { nodeId: "task_a", blocker: "attempt" },
        ],
      });
    });

    it("rejects an empty blocker list", () => {
      assert.throws(() => bindingInUseDetails.parse({ blockers: [] }));
    });

    it("rejects a blocker missing nodeId", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({ blockers: [{ blocker: "run" }] }),
      );
    });

    it("rejects a blocker missing blocker", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({ blockers: [{ nodeId: "task_a" }] }),
      );
    });

    it("rejects an unknown blocker key", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({
          blockers: [{ nodeId: "task_a", blocker: "run", kind: "nope" }],
        }),
      );
    });

    it("rejects the pre-epic kind-based blocker shape", () => {
      assert.throws(() =>
        bindingInUseDetails.parse({
          blockers: [{ kind: "repository", repositoryId: "repo_a" }],
        }),
      );
    });
  });

  describe("illegalTransitionDetails", () => {
    it("parses one node with its state", () => {
      const parsed = illegalTransitionDetails.parse({
        nodes: [{ id: "task_a", state: "running" }],
      });
      assert.deepEqual(parsed, { nodes: [{ id: "task_a", state: "running" }] });
    });

    it("parses several nodes", () => {
      const parsed = illegalTransitionDetails.parse({
        nodes: [
          { id: "task_a", state: "done" },
          { id: "task_b", state: "partial" },
        ],
      });
      assert.deepEqual(parsed, {
        nodes: [
          { id: "task_a", state: "done" },
          { id: "task_b", state: "partial" },
        ],
      });
    });

    it("rejects a node missing its state", () => {
      assert.throws(() =>
        illegalTransitionDetails.parse({ nodes: [{ id: "task_a" }] }),
      );
    });

    it("rejects an unregistered state", () => {
      assert.throws(() =>
        illegalTransitionDetails.parse({
          nodes: [{ id: "task_a", state: "exploded" }],
        }),
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
