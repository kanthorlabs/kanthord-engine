import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { e2eResults, objectiveOutcome, initiativeOutcome } from "./outcome.ts";
import { canTransition } from "./transition.ts";
import { blockReasons } from "./state.ts";
import type { TerminalState, BlockReason } from "./state.ts";
import type { E2eResult } from "./outcome.ts";

describe("src/domain/outcome.test", () => {
  it('e2eResults deep-equals ["pending", "passed", "failed", "not-applicable"]', () => {
    assert.deepEqual(e2eResults, [
      "pending",
      "passed",
      "failed",
      "not-applicable",
    ]);
  });

  describe("objectiveOutcome, all three inputs, exact literals", () => {
    it('"done" → { state: "awaiting_approval", blockReason: null }', () => {
      assert.deepEqual(objectiveOutcome("done"), {
        state: "awaiting_approval",
        blockReason: null,
      });
    });

    it('"partial" → { state: "awaiting_approval", blockReason: null }', () => {
      assert.deepEqual(objectiveOutcome("partial"), {
        state: "awaiting_approval",
        blockReason: null,
      });
    });

    it('"discarded" → { state: "discarded", blockReason: null }', () => {
      assert.deepEqual(objectiveOutcome("discarded"), {
        state: "discarded",
        blockReason: null,
      });
    });

    it('objectiveOutcome("done").state is not "done"', () => {
      assert.notEqual(objectiveOutcome("done").state, "done");
    });
  });

  describe("initiativeOutcome, full 3 × 4 cross product", () => {
    const expected: Array<{
      projected: TerminalState;
      e2e: E2eResult;
      state: string;
      blockReason: BlockReason | null;
    }> = [
      // done row
      {
        projected: "done",
        e2e: "pending",
        state: "running",
        blockReason: null,
      },
      { projected: "done", e2e: "passed", state: "done", blockReason: null },
      {
        projected: "done",
        e2e: "failed",
        state: "blocked",
        blockReason: "e2e-failed",
      },
      {
        projected: "done",
        e2e: "not-applicable",
        state: "done",
        blockReason: null,
      },
      // partial row
      {
        projected: "partial",
        e2e: "pending",
        state: "running",
        blockReason: null,
      },
      {
        projected: "partial",
        e2e: "passed",
        state: "partial",
        blockReason: null,
      },
      {
        projected: "partial",
        e2e: "failed",
        state: "blocked",
        blockReason: "e2e-failed",
      },
      {
        projected: "partial",
        e2e: "not-applicable",
        state: "partial",
        blockReason: null,
      },
      // discarded row (constant across e2e)
      {
        projected: "discarded",
        e2e: "pending",
        state: "discarded",
        blockReason: null,
      },
      {
        projected: "discarded",
        e2e: "passed",
        state: "discarded",
        blockReason: null,
      },
      {
        projected: "discarded",
        e2e: "failed",
        state: "discarded",
        blockReason: null,
      },
      {
        projected: "discarded",
        e2e: "not-applicable",
        state: "discarded",
        blockReason: null,
      },
    ];

    for (const { projected, e2e, state, blockReason } of expected) {
      it(`initiativeOutcome("${projected}", "${e2e}") === { state: "${state}", blockReason: ${JSON.stringify(blockReason)} }`, () => {
        assert.deepEqual(initiativeOutcome(projected, e2e), {
          state,
          blockReason,
        });
      });
    }
  });

  describe("blockReason correctness", () => {
    it("blockReason is null in every result except e2e-failed cells", () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      const e2es: E2eResult[] = [...e2eResults];
      for (const projected of projects) {
        for (const e2e of e2es) {
          const result = initiativeOutcome(projected, e2e);
          if (e2e === "failed" && projected !== "discarded") {
            assert.equal(result.blockReason, "e2e-failed");
            assert.equal(result.state, "blocked");
          } else {
            assert.equal(result.blockReason, null);
          }
        }
      }
    });

    it("every non-null blockReason is a member of blockReasons", () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      const e2es: E2eResult[] = [...e2eResults];
      for (const projected of projects) {
        for (const e2e of e2es) {
          const result = initiativeOutcome(projected, e2e);
          if (result.blockReason !== null) {
            assert.ok(
              blockReasons.includes(result.blockReason),
              `blockReason "${result.blockReason}" is not in blockReasons`,
            );
          }
        }
      }
    });
  });

  describe("agreement with the matrix", () => {
    it("objectiveOutcome: every result state either equals 'running' or canTransition('objective', 'running', state) is true", () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      for (const projected of projects) {
        const result = objectiveOutcome(projected);
        if (result.state !== "running") {
          assert.equal(
            canTransition("objective", "running", result.state),
            true,
            `objectiveOutcome("${projected}").state = "${result.state}" but canTransition("objective", "running", "${result.state}") is false`,
          );
        }
      }
    });

    it("initiativeOutcome: every result state either equals 'running' or canTransition('initiative', 'running', state) is true", () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      const e2es: E2eResult[] = [...e2eResults];
      for (const projected of projects) {
        for (const e2e of e2es) {
          const result = initiativeOutcome(projected, e2e);
          if (result.state !== "running") {
            assert.equal(
              canTransition("initiative", "running", result.state),
              true,
              `initiativeOutcome("${projected}", "${e2e}").state = "${result.state}" but canTransition("initiative", "running", "${result.state}") is false`,
            );
          }
        }
      }
    });

    it('objectiveOutcome never returns "done" or "partial" as a state', () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      for (const projected of projects) {
        const result = objectiveOutcome(projected);
        assert.notEqual(result.state, "done");
        assert.notEqual(result.state, "partial");
      }
    });

    it('initiativeOutcome never returns "awaiting_approval"', () => {
      const projects: TerminalState[] = ["done", "partial", "discarded"];
      const e2es: E2eResult[] = [...e2eResults];
      for (const projected of projects) {
        for (const e2e of e2es) {
          const result = initiativeOutcome(projected, e2e);
          assert.notEqual(result.state, "awaiting_approval");
        }
      }
    });
  });
});
