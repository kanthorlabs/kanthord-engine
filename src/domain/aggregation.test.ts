import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { aggregate, AggregationError } from "./aggregation.ts";
import { terminalStates } from "./state.ts";
import type { TerminalState } from "./state.ts";

describe("src/domain/aggregation.test", () => {
  describe("literal table, objective parent", () => {
    const cases: Array<{ children: TerminalState[]; result: TerminalState }> = [
      { children: ["done"], result: "done" },
      { children: ["discarded"], result: "discarded" },
      { children: ["done", "done"], result: "done" },
      { children: ["done", "discarded"], result: "partial" },
      { children: ["discarded", "done"], result: "partial" },
      { children: ["discarded", "discarded"], result: "discarded" },
    ];
    for (const { children, result } of cases) {
      it(`aggregate("objective", ${JSON.stringify(children)}) === "${result}"`, () => {
        assert.equal(aggregate("objective", children), result);
      });
    }
  });

  describe("literal table, initiative parent", () => {
    const cases: Array<{ children: TerminalState[]; result: TerminalState }> = [
      { children: ["done"], result: "done" },
      { children: ["partial"], result: "partial" },
      { children: ["discarded"], result: "discarded" },
      { children: ["done", "done"], result: "done" },
      { children: ["done", "partial"], result: "partial" },
      { children: ["done", "discarded"], result: "partial" },
      { children: ["partial", "done"], result: "partial" },
      { children: ["partial", "partial"], result: "partial" },
      { children: ["partial", "discarded"], result: "partial" },
      { children: ["discarded", "done"], result: "partial" },
      { children: ["discarded", "partial"], result: "partial" },
      { children: ["discarded", "discarded"], result: "discarded" },
    ];
    for (const { children, result } of cases) {
      it(`aggregate("initiative", ${JSON.stringify(children)}) === "${result}"`, () => {
        assert.equal(aggregate("initiative", children), result);
      });
    }
  });

  describe("generated sweep, size 3, objective parent", () => {
    const childDomain: TerminalState[] = ["done", "discarded"];
    const tuples: TerminalState[][] = [];
    for (const a of childDomain) {
      for (const b of childDomain) {
        for (const c of childDomain) {
          tuples.push([a, b, c]);
        }
      }
    }
    for (const children of tuples) {
      it(`aggregate("objective", ${JSON.stringify(children)}) matches count oracle`, () => {
        const doneCount = children.filter((c) => c === "done").length;
        const discardedCount = children.filter((c) => c === "discarded").length;
        const expected =
          doneCount === children.length
            ? "done"
            : discardedCount === children.length
              ? "discarded"
              : "partial";
        assert.equal(aggregate("objective", children), expected);
      });
    }
  });

  describe("generated sweep, size 3, initiative parent", () => {
    const childDomain: TerminalState[] = ["done", "partial", "discarded"];
    const tuples: TerminalState[][] = [];
    for (const a of childDomain) {
      for (const b of childDomain) {
        for (const c of childDomain) {
          tuples.push([a, b, c]);
        }
      }
    }
    for (const children of tuples) {
      it(`aggregate("initiative", ${JSON.stringify(children)}) matches count oracle`, () => {
        const doneCount = children.filter((c) => c === "done").length;
        const discardedCount = children.filter((c) => c === "discarded").length;
        const expected =
          doneCount === children.length
            ? "done"
            : discardedCount === children.length
              ? "discarded"
              : "partial";
        assert.equal(aggregate("initiative", children), expected);
      });
    }
  });

  describe("permutation invariance", () => {
    const childDomain: TerminalState[] = ["done", "partial", "discarded"];
    const tuples: TerminalState[][] = [];
    for (const a of childDomain) {
      for (const b of childDomain) {
        for (const c of childDomain) {
          tuples.push([a, b, c]);
        }
      }
    }
    for (const children of tuples) {
      it(`aggregate("initiative", ${JSON.stringify(children)}) === aggregate("initiative", reversed)`, () => {
        const reversed = [...children].reverse();
        assert.equal(
          aggregate("initiative", children),
          aggregate("initiative", reversed),
        );
      });
    }
  });

  describe("errors", () => {
    it('aggregate("objective", []) throws with code "empty-parent"', () => {
      try {
        aggregate("objective", []);
        assert.fail("expected AggregationError");
      } catch (err) {
        assert.ok(err instanceof AggregationError);
        assert.equal(err.code, "empty-parent");
      }
    });

    it('aggregate("initiative", []) throws with code "empty-parent"', () => {
      try {
        aggregate("initiative", []);
        assert.fail("expected AggregationError");
      } catch (err) {
        assert.ok(err instanceof AggregationError);
        assert.equal(err.code, "empty-parent");
      }
    });

    it('aggregate("objective", ["partial"]) throws with code "invalid-child-state"', () => {
      try {
        aggregate("objective", ["partial"]);
        assert.fail("expected AggregationError");
      } catch (err) {
        assert.ok(err instanceof AggregationError);
        assert.equal(err.code, "invalid-child-state");
      }
    });

    it('aggregate("objective", ["done", "partial"]) throws with code "invalid-child-state"', () => {
      try {
        aggregate("objective", ["done", "partial"]);
        assert.fail("expected AggregationError");
      } catch (err) {
        assert.ok(err instanceof AggregationError);
        assert.equal(err.code, "invalid-child-state");
      }
    });

    it("every thrown error is an instance of AggregationError", () => {
      const cases = [
        () => aggregate("objective", []),
        () => aggregate("initiative", []),
        () => aggregate("objective", ["partial"]),
        () => aggregate("objective", ["done", "partial"]),
      ];
      for (const fn of cases) {
        assert.throws(fn, AggregationError);
      }
    });
  });

  describe("result domain", () => {
    it("every result is a member of terminalStates", () => {
      const allCases: TerminalState[][] = [
        ["done"],
        ["partial"],
        ["discarded"],
        ["done", "done"],
        ["done", "partial"],
        ["done", "discarded"],
        ["partial", "done"],
        ["partial", "partial"],
        ["partial", "discarded"],
        ["discarded", "done"],
        ["discarded", "partial"],
        ["discarded", "discarded"],
      ];
      for (const children of allCases) {
        const result = aggregate("initiative", children);
        assert.ok(
          terminalStates.includes(result),
          `result "${result}" is not in terminalStates`,
        );
        assert.notEqual(result, "running");
        assert.notEqual(result, "pending");
        assert.notEqual(result, "ready");
        assert.notEqual(result, "blocked");
        assert.notEqual(result, "awaiting_approval");
      }
    });
  });
});
