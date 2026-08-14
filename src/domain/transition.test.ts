import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { transitions, canTransition } from "./transition.ts";
import { nodeStates } from "./state.ts";
import type { NodeKind, NodeState } from "./state.ts";

describe("src/domain/transition.test", () => {
  const allowedPairs: Record<NodeKind, Set<string>> = {
    task: new Set([
      "pending→ready",
      "pending→blocked",
      "pending→discarded",
      "ready→pending",
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
      "ready→pending",
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
      "ready→pending",
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

  it("only blocked→pending and ready→pending write pending", () => {
    for (const from of nodeStates) {
      if (from === "blocked" || from === "ready") continue;
      for (const level of ["task", "objective", "initiative"] as const) {
        assert.equal(
          canTransition(level, from, "pending"),
          false,
          `canTransition("${level}", "${from}", "pending") should be false`,
        );
      }
    }
    for (const level of ["task", "objective", "initiative"] as const) {
      assert.equal(
        canTransition(level, "blocked", "pending"),
        true,
        `canTransition("${level}", "blocked", "pending") should be true`,
      );
      assert.equal(
        canTransition(level, "ready", "pending"),
        true,
        `canTransition("${level}", "ready", "pending") should be true`,
      );
    }
  });

  it("every matrix row of state-machine.md equals its transitions row", () => {
    const lines = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-1/state-machine.md",
      ),
      "utf-8",
    ).split("\n");
    const rows: string[][] = [];
    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      const cells = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      if (cells.length !== 6) continue;
      if (!/^`([a-z_]+)`$/.test(cells[0]!)) continue;
      if (!/^`([a-z_]+)`$/.test(cells[1]!)) continue;
      rows.push(cells);
    }
    assert.equal(
      rows.length,
      36,
      "expected 36 matrix rows in state-machine.md",
    );
    for (const cells of rows) {
      const from = cells[0]!.replace(/^`|`$/g, "");
      const to = cells[1]!.replace(/^`|`$/g, "");
      const row = transitions.find((r) => r.from === from && r.to === to);
      assert.ok(row, `no transitions row for ${from}→${to}`);
      assert.equal(row.note, cells[5]!, `note mismatch at ${from}→${to}`);
      assert.equal(
        cells[2]!,
        row.task ? "✅" : "❌",
        `task mark mismatch at ${from}→${to}`,
      );
      assert.equal(
        cells[3]!,
        row.objective ? "✅" : "❌",
        `objective mark mismatch at ${from}→${to}`,
      );
      assert.equal(
        cells[4]!,
        row.initiative ? "✅" : "❌",
        `initiative mark mismatch at ${from}→${to}`,
      );
    }
  });

  it("five notes name the external trigger", () => {
    const pairs = [
      ["running", "ready"],
      ["running", "awaiting_approval"],
      ["running", "done"],
      ["awaiting_approval", "done"],
      ["awaiting_approval", "partial"],
    ] as const;
    for (const [from, to] of pairs) {
      const row = transitions.find((r) => r.from === from && r.to === to);
      assert.ok(row, `no transitions row for ${from}→${to}`);
      assert.ok(
        row.note.includes("external"),
        `note for ${from}→${to} does not name the external trigger`,
      );
    }
  });

  it("the pending-writer paragraph names the blocked→pending and ready→pending writers", () => {
    const lines = readFileSync(
      resolve(
        import.meta.dirname,
        "../../docs/proposal/phase-1/state-machine.md",
      ),
      "utf-8",
    ).split("\n");
    const paragraph = lines.find((line) =>
      line.includes("An abandon never returns a node to `pending`"),
    );
    assert.ok(paragraph, "no pending-writer paragraph in state-machine.md");
    assert.ok(
      paragraph!.includes("topology write"),
      "the paragraph does not name the ready→pending topology writer",
    );
    assert.ok(
      paragraph!.includes("import"),
      "the paragraph does not name the import writer",
    );
    assert.ok(
      paragraph!.includes("unblock"),
      "the paragraph does not name the blocked→pending unblock writer",
    );
    assert.ok(
      !paragraph!.includes("the only writers of"),
      "the paragraph still claims import and unblock are the only pending writers",
    );
  });
});
