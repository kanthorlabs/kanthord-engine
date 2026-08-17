import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canTransition } from "./transition.ts";
import {
  externalTransitions,
  externalTriggerIds,
} from "./external-transition.ts";
import {
  internalTransitions,
  internalTriggerIds,
  triggerTransition,
  type InternalTransition,
} from "./node-trigger.ts";

const expected: readonly InternalTransition[] = [
  {
    levels: ["initiative", "objective", "task"],
    from: "pending",
    to: "ready",
    trigger: "readiness-promoted",
  },
  {
    levels: ["initiative", "objective", "task"],
    from: "ready",
    to: "pending",
    trigger: "readiness-demoted",
  },
  {
    levels: ["objective", "task"],
    from: "ready",
    to: "running",
    trigger: "claim-taken",
  },
  {
    levels: ["initiative", "objective"],
    from: "ready",
    to: "running",
    trigger: "ancestor-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "recovery-requeued",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "recovery-blocked",
  },
  {
    levels: ["objective"],
    from: "ready",
    to: "running",
    trigger: "worker-objective-started",
  },
  {
    levels: ["task"],
    from: "ready",
    to: "running",
    trigger: "worker-task-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "done",
    trigger: "worker-task-accepted",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "worker-attempt-limit-reached",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "run-cancelled-requeued",
  },
  {
    levels: ["objective"],
    from: "running",
    to: "blocked",
    trigger: "run-cancelled-abandoned",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "done",
    trigger: "initiative-aggregated-done",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "partial",
    trigger: "initiative-aggregated-partial",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "discarded",
    trigger: "initiative-aggregated-discarded",
  },
  {
    levels: ["task"],
    from: "blocked",
    to: "pending",
    trigger: "manual-unblock",
  },
];

const fixedLevelOrder = ["initiative", "objective", "task"] as const;

describe("src/domain/node-trigger.test", () => {
  it("internalTriggerIds pins the sixteen trigger ids in row order", () => {
    assert.equal(internalTriggerIds.length, 16);
    assert.deepEqual(
      [...internalTriggerIds],
      [
        "readiness-promoted",
        "readiness-demoted",
        "claim-taken",
        "ancestor-started",
        "recovery-requeued",
        "recovery-blocked",
        "worker-objective-started",
        "worker-task-started",
        "worker-task-accepted",
        "worker-attempt-limit-reached",
        "run-cancelled-requeued",
        "run-cancelled-abandoned",
        "initiative-aggregated-done",
        "initiative-aggregated-partial",
        "initiative-aggregated-discarded",
        "manual-unblock",
      ],
    );
    assert.equal(new Set(internalTriggerIds).size, 16);
  });

  it("internalTransitions holds exactly sixteen rows in exactly the declared order", () => {
    assert.equal(internalTransitions.length, 16);
    assert.deepEqual(internalTransitions, expected);
    assert.deepEqual(
      internalTransitions.map((row) => row.trigger),
      [...internalTriggerIds],
    );
  });

  it("every levels list is non-empty, duplicate-free and fixed-order", () => {
    for (const row of internalTransitions) {
      assert.ok(row.levels.length > 0, `${row.trigger} levels is empty`);
      assert.equal(
        new Set(row.levels).size,
        row.levels.length,
        `${row.trigger} levels holds a duplicate`,
      );
      const ordered = fixedLevelOrder.filter((level) =>
        row.levels.includes(level),
      );
      assert.deepEqual(ordered, row.levels);
    }
  });

  it("every row names a legal cell at every level", () => {
    for (const row of internalTransitions) {
      for (const level of row.levels) {
        assert.equal(
          canTransition(level, row.from, row.to),
          true,
          `${level} ${row.from} → ${row.to} should be legal`,
        );
      }
    }
  });

  it("the external id set and the internal id set stay disjoint", () => {
    const external = new Set<string>([...externalTriggerIds]);
    for (const id of internalTriggerIds) {
      assert.ok(
        !external.has(id),
        `externalTriggerIds holds internal id ${id}`,
      );
    }
    const union = new Set([...internalTriggerIds, ...externalTriggerIds]);
    assert.equal(union.size, 26);
  });

  it("triggerTransition returns the declared triple for every internal trigger", () => {
    for (const row of internalTransitions) {
      assert.deepEqual(triggerTransition(row.trigger), {
        levels: row.levels,
        from: row.from,
        to: row.to,
      });
    }
  });

  it("triggerTransition reads an external row's single level as a one-member list", () => {
    for (const row of externalTransitions) {
      assert.deepEqual(triggerTransition(row.trigger), {
        levels: [row.level],
        from: row.from,
        to: row.to,
      });
    }
  });

  it("triggerTransition returns the declared triple for claim-released and for claim-expired", () => {
    assert.deepEqual(triggerTransition("claim-released"), {
      levels: ["task"],
      from: "running",
      to: "ready",
    });
    assert.deepEqual(triggerTransition("claim-expired"), {
      levels: ["task"],
      from: "running",
      to: "ready",
    });
  });

  it("the union of both tables covers every pair a command of EPICs 016, 018, 019 and 110 writes", () => {
    const pairs = new Set<string>();
    for (const row of internalTransitions) {
      for (const level of row.levels) {
        pairs.add(`${level}|${row.from}|${row.to}`);
      }
    }
    for (const row of externalTransitions) {
      pairs.add(`${row.level}|${row.from}|${row.to}`);
    }
    assert.deepEqual([...pairs].sort(), [
      "initiative|pending|ready",
      "initiative|ready|pending",
      "initiative|ready|running",
      "initiative|running|discarded",
      "initiative|running|done",
      "initiative|running|partial",
      "objective|awaiting_approval|done",
      "objective|awaiting_approval|partial",
      "objective|pending|ready",
      "objective|ready|pending",
      "objective|ready|running",
      "objective|running|awaiting_approval",
      "objective|running|blocked",
      "task|blocked|pending",
      "task|pending|ready",
      "task|ready|pending",
      "task|ready|running",
      "task|running|blocked",
      "task|running|done",
      "task|running|ready",
    ]);
  });
});
