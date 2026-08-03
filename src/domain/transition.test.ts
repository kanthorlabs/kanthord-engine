import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { transitions, canTransition } from "./transition.ts";
import { nodeStates } from "./state.ts";
import type { NodeKind, NodeState } from "./state.ts";

describe("src/domain/transition.test", () => {
  const allowedPairs: Record<NodeKind, Set<string>> = {
    task: new Set([
      "pending→ready",
      "pending→blocked",
      "pending→discarded",
      "ready→running",
      "ready→blocked",
      "ready→discarded",
      "running→ready",
      "running→blocked",
      "running→done",
      "blocked→pending",
      "blocked→discarded",
      "done→blocked",
    ]),
    objective: new Set([
      "pending→ready",
      "pending→blocked",
      "pending→discarded",
      "ready→running",
      "ready→blocked",
      "ready→discarded",
      "running→blocked",
      "running→awaiting_approval",
      "running→discarded",
      "blocked→pending",
      "blocked→discarded",
      "awaiting_approval→blocked",
      "awaiting_approval→done",
      "awaiting_approval→partial",
    ]),
    initiative: new Set([
      "pending→ready",
      "pending→blocked",
      "pending→discarded",
      "ready→running",
      "ready→blocked",
      "ready→discarded",
      "running→blocked",
      "running→done",
      "running→partial",
      "running→discarded",
      "blocked→pending",
      "blocked→discarded",
    ]),
  };

  it("transitions.length equals 56", () => {
    assert.equal(transitions.length, 56);
  });

  it("full cross product covered exactly once", () => {
    const expected = new Set<string>();
    for (const from of nodeStates) {
      for (const to of nodeStates) {
        if (from !== to) {
          expected.add(`${from}→${to}`);
        }
      }
    }
    assert.equal(expected.size, 56);

    const actual = new Set(transitions.map((row) => `${row.from}→${row.to}`));
    assert.equal(actual.size, 56);
    assert.deepEqual(actual, expected);
  });

  it("no duplicate row", () => {
    const keys = transitions.map((row) => `${row.from}→${row.to}`);
    assert.equal(new Set(keys).size, 56);
  });

  it("transitions is sorted by from then to per nodeStates order", () => {
    const indices = transitions.map(
      (row) =>
        nodeStates.indexOf(row.from) * nodeStates.length +
        nodeStates.indexOf(row.to),
    );
    for (let i = 1; i < indices.length; i++) {
      const current = indices[i]!;
      const previous = indices[i - 1]!;
      assert.ok(
        current > previous,
        `row ${i} is out of order: ${previous} >= ${current}`,
      );
    }
  });

  it("every row has a non-empty single-line note", () => {
    for (const row of transitions) {
      assert.ok(row.note.length > 0, `empty note at ${row.from}→${row.to}`);
      assert.ok(
        !row.note.includes("\n"),
        `note contains newline at ${row.from}→${row.to}`,
      );
    }
  });

  it("exhaustive per-level assertion", () => {
    for (const from of nodeStates) {
      for (const to of nodeStates) {
        if (from === to) continue;
        const key = `${from}→${to}`;
        for (const level of ["task", "objective", "initiative"] as const) {
          assert.equal(
            canTransition(level, from, to),
            allowedPairs[level].has(key),
            `canTransition("${level}", "${from}", "${to}") should be ${allowedPairs[level].has(key)} for ${key}`,
          );
        }
      }
    }
  });

  it("transitions agrees with canTransition for every row", () => {
    for (const row of transitions) {
      assert.equal(
        row.task,
        canTransition("task", row.from, row.to),
        `task mismatch at ${row.from}→${row.to}`,
      );
      assert.equal(
        row.objective,
        canTransition("objective", row.from, row.to),
        `objective mismatch at ${row.from}→${row.to}`,
      );
      assert.equal(
        row.initiative,
        canTransition("initiative", row.from, row.to),
        `initiative mismatch at ${row.from}→${row.to}`,
      );
    }
  });

  it("identity pairs return false for every state and level", () => {
    for (const state of nodeStates) {
      for (const level of ["task", "objective", "initiative"] as const) {
        assert.equal(
          canTransition(level, state, state),
          false,
          `canTransition("${level}", "${state}", "${state}") should be false`,
        );
      }
    }
  });

  it("terminal fences: partial is terminal", () => {
    for (const to of nodeStates) {
      if (to === "partial") continue;
      for (const level of ["task", "objective", "initiative"] as const) {
        assert.equal(
          canTransition(level, "partial", to),
          false,
          `canTransition("${level}", "partial", "${to}") should be false`,
        );
      }
    }
  });

  it("terminal fences: discarded is terminal", () => {
    for (const to of nodeStates) {
      if (to === "discarded") continue;
      for (const level of ["task", "objective", "initiative"] as const) {
        assert.equal(
          canTransition(level, "discarded", to),
          false,
          `canTransition("${level}", "discarded", "${to}") should be false`,
        );
      }
    }
  });

  it("terminal fences: done only goes to blocked for task", () => {
    for (const to of nodeStates) {
      if (to === "done") continue;
      if (to === "blocked") {
        assert.equal(
          canTransition("task", "done", "blocked"),
          true,
          'canTransition("task", "done", "blocked") should be true',
        );
        assert.equal(
          canTransition("objective", "done", "blocked"),
          false,
          'canTransition("objective", "done", "blocked") should be false',
        );
        assert.equal(
          canTransition("initiative", "done", "blocked"),
          false,
          'canTransition("initiative", "done", "blocked") should be false',
        );
      } else {
        for (const level of ["task", "objective", "initiative"] as const) {
          assert.equal(
            canTransition(level, "done", to),
            false,
            `canTransition("${level}", "done", "${to}") should be false`,
          );
        }
      }
    }
  });

  it("the gate is objective-only: awaiting_approval", () => {
    for (const from of nodeStates) {
      assert.equal(
        canTransition("task", from, "awaiting_approval"),
        false,
        `canTransition("task", "${from}", "awaiting_approval") should be false`,
      );
      assert.equal(
        canTransition("initiative", from, "awaiting_approval"),
        false,
        `canTransition("initiative", "${from}", "awaiting_approval") should be false`,
      );
    }
  });

  it("a task never reaches partial", () => {
    for (const from of nodeStates) {
      assert.equal(
        canTransition("task", from, "partial"),
        false,
        `canTransition("task", "${from}", "partial") should be false`,
      );
    }
  });

  it("only blocked→pending writes pending", () => {
    for (const from of nodeStates) {
      if (from === "blocked") continue;
      for (const level of ["task", "objective", "initiative"] as const) {
        assert.equal(
          canTransition(level, from, "pending"),
          false,
          `canTransition("${level}", "${from}", "pending") should be false`,
        );
      }
    }
  });
});
