import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  satisfiesDependency,
  isReady,
  blockReasonClearance,
  clearedByUnblock,
} from "./readiness.ts";
import { nodeStates, blockReasons } from "./state.ts";
import type { NodeState, BlockReason } from "./state.ts";
import type { Dependency } from "./readiness.ts";

describe("src/domain/readiness.test", () => {
  describe("satisfiesDependency", () => {
    for (const state of nodeStates) {
      it(`satisfiesDependency("${state}") === ${state === "done" || state === "partial"}`, () => {
        assert.equal(
          satisfiesDependency(state),
          state === "done" || state === "partial",
        );
      });
    }
  });

  describe("isReady", () => {
    it("isReady([]) is true", () => {
      assert.equal(isReady([]), true);
    });

    it('isReady([{ state: "done", waived: false }]) is true', () => {
      assert.equal(isReady([{ state: "done", waived: false }]), true);
    });

    it('isReady([{ state: "partial", waived: false }]) is true', () => {
      assert.equal(isReady([{ state: "partial", waived: false }]), true);
    });

    it('isReady(["done", "partial"]) is true', () => {
      assert.equal(
        isReady([
          { state: "done", waived: false },
          { state: "partial", waived: false },
        ]),
        true,
      );
    });

    const nonSatisfyingStates: NodeState[] = [
      "pending",
      "ready",
      "running",
      "blocked",
      "awaiting_approval",
      "discarded",
    ];

    for (const state of nonSatisfyingStates) {
      it(`isReady([{ state: "${state}", waived: false }]) is false`, () => {
        assert.equal(isReady([{ state, waived: false }]), false);
      });

      it(`isReady(["done", "${state}"]) is false when not waived`, () => {
        assert.equal(
          isReady([
            { state: "done", waived: false },
            { state, waived: false },
          ]),
          false,
        );
      });
    }

    for (const state of nonSatisfyingStates) {
      it(`isReady([{ state: "${state}", waived: true }]) is true — waived edge is ignored`, () => {
        assert.equal(isReady([{ state, waived: true }]), true);
      });
    }

    it("isReady([discarded waived, running not waived]) is false", () => {
      assert.equal(
        isReady([
          { state: "discarded", waived: true },
          { state: "running", waived: false },
        ]),
        false,
      );
    });
  });

  describe("blockReasonClearance", () => {
    it("has 6 entries, one per blockReason", () => {
      assert.equal(Object.keys(blockReasonClearance).length, 6);
      for (const reason of blockReasons) {
        assert.ok(reason in blockReasonClearance, `missing key "${reason}"`);
      }
    });

    const expectedClearances: Record<BlockReason, readonly string[]> = {
      "attempt-limit": ["unblock"],
      "dependency-discarded": ["waive", "import"],
      "stale-base": ["unblock"],
      "dirty-recovery": ["unblock"],
      "e2e-failed": ["import"],
      abandoned: ["unblock"],
    };

    for (const [reason, clearances] of Object.entries(expectedClearances)) {
      it(`blockReasonClearance["${reason}"] deep-equals ${JSON.stringify(clearances)}`, () => {
        assert.deepEqual(
          blockReasonClearance[reason as BlockReason],
          clearances,
        );
      });
    }

    it("every list is non-empty and contains only valid clearances", () => {
      const validClearances = ["unblock", "waive", "import"];
      for (const reason of blockReasons) {
        const list = blockReasonClearance[reason];
        assert.ok(list.length > 0, `empty list for "${reason}"`);
        for (const clearance of list) {
          assert.ok(
            validClearances.includes(clearance),
            `invalid clearance "${clearance}" for "${reason}"`,
          );
        }
      }
    });
  });

  describe("clearedByUnblock", () => {
    it('blockReasons.filter(clearedByUnblock) deep-equals ["attempt-limit", "stale-base", "dirty-recovery", "abandoned"]', () => {
      assert.deepEqual(blockReasons.filter(clearedByUnblock), [
        "attempt-limit",
        "stale-base",
        "dirty-recovery",
        "abandoned",
      ]);
    });

    it('clearedByUnblock("dependency-discarded") is false', () => {
      assert.equal(clearedByUnblock("dependency-discarded"), false);
    });

    it('clearedByUnblock("e2e-failed") is false', () => {
      assert.equal(clearedByUnblock("e2e-failed"), false);
    });
  });
});
