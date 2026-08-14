import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  externalTriggerConsumer,
  externalTriggerIds,
  externalTransitions,
  objectiveDrivePin,
  type ExternalTransition,
} from "./external-transition.ts";
import { internalTriggerIds } from "./node-trigger.ts";
import { canTransition } from "./transition.ts";

const expected: readonly ExternalTransition[] = [
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "attempt-rejected",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "done",
    trigger: "outcome-accepted",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "blocked",
    trigger: "attempt-limit-reached",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "reached",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "objective",
    from: "running",
    to: "awaiting_approval",
    trigger: "object-reported",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-terminal-one-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "done",
    trigger: "human-close",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "partial",
    trigger: "human-close-partial",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "at-least-one-task-discarded",
    },
  },
];

function rowByTrigger(trigger: string): ExternalTransition {
  const row = externalTransitions.find((entry) => entry.trigger === trigger);
  assert.ok(row, `no row for trigger ${trigger}`);
  return row;
}

describe("src/domain/external-transition.test", () => {
  it("externalTriggerIds pins the six trigger ids in row order", () => {
    assert.equal(externalTriggerIds.length, 6);
    assert.deepEqual(
      [...externalTriggerIds],
      [
        "attempt-rejected",
        "outcome-accepted",
        "attempt-limit-reached",
        "object-reported",
        "human-close",
        "human-close-partial",
      ],
    );
    assert.equal(new Set(externalTriggerIds).size, 6);
  });

  it("externalTransitions holds exactly six rows in exactly the declared order", () => {
    assert.equal(externalTransitions.length, 6);
    assert.deepEqual(externalTransitions, expected);
    assert.deepEqual(
      externalTransitions.map((row) => row.trigger),
      [...externalTriggerIds],
    );
  });

  it("every row names a legal cell", () => {
    for (const row of externalTransitions) {
      assert.equal(
        canTransition(row.level, row.from, row.to),
        true,
        `${row.level} ${row.from} → ${row.to} should be legal`,
      );
    }
  });

  it("every row carries runDriver external and activeRun true", () => {
    for (const row of externalTransitions) {
      assert.equal(row.precondition.runDriver, "external");
      assert.equal(row.precondition.activeRun, true);
    }
  });

  it("the object-reported row carries a valid lease fence and the harness actor kind", () => {
    const row = rowByTrigger("object-reported");
    assert.equal(row.precondition.leaseFence, "valid");
    assert.equal(row.precondition.actorKind, "harness");
  });

  it("the outcome-accepted row carries a required reported object id", () => {
    const row = rowByTrigger("outcome-accepted");
    assert.equal(row.precondition.reportedObjectId, "required");
  });

  it("the attempt-rejected row carries the attempt-rejected precondition", () => {
    const row = rowByTrigger("attempt-rejected");
    assert.equal(row.level, "task");
    assert.equal(row.from, "running");
    assert.equal(row.to, "ready");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "valid");
    assert.equal(row.precondition.actorKind, "harness");
    assert.equal(row.precondition.attemptLimit, "under");
    assert.equal(row.precondition.reportedObjectId, "absent");
    assert.equal(row.precondition.childAggregation, "not-applicable");
  });

  it("the outcome-accepted row carries the outcome-accepted precondition", () => {
    const row = rowByTrigger("outcome-accepted");
    assert.equal(row.level, "task");
    assert.equal(row.from, "running");
    assert.equal(row.to, "done");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "valid");
    assert.equal(row.precondition.actorKind, "harness");
    assert.equal(row.precondition.attemptLimit, "not-applicable");
    assert.equal(row.precondition.reportedObjectId, "required");
    assert.equal(row.precondition.childAggregation, "not-applicable");
  });

  it("the attempt-limit-reached row carries the attempt-limit-reached precondition", () => {
    const row = rowByTrigger("attempt-limit-reached");
    assert.equal(row.level, "task");
    assert.equal(row.from, "running");
    assert.equal(row.to, "blocked");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "valid");
    assert.equal(row.precondition.actorKind, "harness");
    assert.equal(row.precondition.attemptLimit, "reached");
    assert.equal(row.precondition.reportedObjectId, "absent");
    assert.equal(row.precondition.childAggregation, "not-applicable");
  });

  it("the object-reported row carries the object-reported precondition", () => {
    const row = rowByTrigger("object-reported");
    assert.equal(row.level, "objective");
    assert.equal(row.from, "running");
    assert.equal(row.to, "awaiting_approval");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "valid");
    assert.equal(row.precondition.actorKind, "harness");
    assert.equal(row.precondition.attemptLimit, "not-applicable");
    assert.equal(row.precondition.reportedObjectId, "required");
    assert.equal(
      row.precondition.childAggregation,
      "every-task-terminal-one-done",
    );
  });

  it("the human-close row carries the human-close precondition", () => {
    const row = rowByTrigger("human-close");
    assert.equal(row.level, "objective");
    assert.equal(row.from, "awaiting_approval");
    assert.equal(row.to, "done");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "none");
    assert.equal(row.precondition.actorKind, "human");
    assert.equal(row.precondition.attemptLimit, "not-applicable");
    assert.equal(row.precondition.reportedObjectId, "required");
    assert.equal(row.precondition.childAggregation, "every-task-done");
  });

  it("the human-close-partial row carries the human-close-partial precondition", () => {
    const row = rowByTrigger("human-close-partial");
    assert.equal(row.level, "objective");
    assert.equal(row.from, "awaiting_approval");
    assert.equal(row.to, "partial");
    assert.equal(row.precondition.runDriver, "external");
    assert.equal(row.precondition.activeRun, true);
    assert.equal(row.precondition.leaseFence, "none");
    assert.equal(row.precondition.actorKind, "human");
    assert.equal(row.precondition.attemptLimit, "not-applicable");
    assert.equal(row.precondition.reportedObjectId, "required");
    assert.equal(
      row.precondition.childAggregation,
      "at-least-one-task-discarded",
    );
  });

  describe("objectiveDrivePin", () => {
    it("an empty run history pins nothing under either claim driver", () => {
      assert.equal(
        objectiveDrivePin({ runDrivers: [], claimDriver: "internal" }),
        null,
      );
      assert.equal(
        objectiveDrivePin({ runDrivers: [], claimDriver: "external" }),
        null,
      );
    });

    it("a uniform run history pins nothing in both directions", () => {
      assert.equal(
        objectiveDrivePin({
          runDrivers: ["internal", "internal"],
          claimDriver: "internal",
        }),
        null,
      );
      assert.equal(
        objectiveDrivePin({
          runDrivers: ["external", "external"],
          claimDriver: "external",
        }),
        null,
      );
    });

    it("a single-member run history matching the claim driver pins nothing in both directions", () => {
      assert.equal(
        objectiveDrivePin({
          runDrivers: ["internal"],
          claimDriver: "internal",
        }),
        null,
      );
      assert.equal(
        objectiveDrivePin({
          runDrivers: ["external"],
          claimDriver: "external",
        }),
        null,
      );
    });

    it("a run history holding only the other driver refuses it as pinnedDriver in both directions", () => {
      assert.deepEqual(
        objectiveDrivePin({
          runDrivers: ["external"],
          claimDriver: "internal",
        }),
        { pinnedDriver: "external", claimDriver: "internal" },
      );
      assert.deepEqual(
        objectiveDrivePin({
          runDrivers: ["internal"],
          claimDriver: "external",
        }),
        { pinnedDriver: "internal", claimDriver: "external" },
      );
    });

    it("a mixed run history refuses the first differing member in both directions", () => {
      assert.deepEqual(
        objectiveDrivePin({
          runDrivers: ["internal", "external"],
          claimDriver: "external",
        }),
        { pinnedDriver: "internal", claimDriver: "external" },
      );
      assert.deepEqual(
        objectiveDrivePin({
          runDrivers: ["external", "internal"],
          claimDriver: "internal",
        }),
        { pinnedDriver: "external", claimDriver: "internal" },
      );
    });
  });

  describe("externalTriggerConsumer", () => {
    it("is total over the external trigger ids", () => {
      const keys = Object.keys(externalTriggerConsumer);
      assert.equal(keys.length, 6);
      assert.equal(externalTriggerIds.length, keys.length);
      for (const id of externalTriggerIds) {
        assert.ok(id in externalTriggerConsumer, `missing key ${id}`);
      }
      for (const key of keys) {
        assert.ok(
          (externalTriggerIds as readonly string[]).includes(key),
          `unexpected key ${key}`,
        );
      }
    });

    it("names a command module path under src/commands for every trigger", () => {
      for (const value of Object.values(externalTriggerConsumer)) {
        assert.ok(
          value.startsWith("src/commands/"),
          `value ${value} is not a command path`,
        );
      }
    });

    it("maps object-reported to the attestation command", () => {
      assert.equal(
        externalTriggerConsumer["object-reported"],
        "src/commands/outcome/report-objective.ts",
      );
    });

    it("names no aggregate-objective command", () => {
      for (const value of Object.values(externalTriggerConsumer)) {
        assert.notEqual(value, "src/commands/outcome/aggregate-objective.ts");
        assert.ok(
          !value.includes("src/commands/outcome/aggregate-objective.ts"),
        );
      }
    });

    it("holds no internal trigger id as a key", () => {
      for (const id of internalTriggerIds) {
        assert.ok(!(id in externalTriggerConsumer), `internal key ${id}`);
      }
    });

    it("maps the three report-outcome triggers and the two close triggers in id order", () => {
      const reportOutcomeKeys = externalTriggerIds.filter(
        (id) =>
          externalTriggerConsumer[id] ===
          "src/commands/outcome/report-outcome.ts",
      );
      assert.deepEqual(reportOutcomeKeys, [
        "attempt-rejected",
        "outcome-accepted",
        "attempt-limit-reached",
      ]);
      const closeObjectiveKeys = externalTriggerIds.filter(
        (id) =>
          externalTriggerConsumer[id] ===
          "src/commands/outcome/close-objective.ts",
      );
      assert.deepEqual(closeObjectiveKeys, [
        "human-close",
        "human-close-partial",
      ]);
    });
  });
});
