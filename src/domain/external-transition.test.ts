import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  externalTriggerConsumer,
  externalTriggerIds,
  externalTransitions,
  objectiveDrivePin,
  type ExternalPrecondition,
  type ExternalTransition,
} from "./external-transition.ts";
import { internalTriggerIds } from "./node-trigger.ts";
import { canTransition } from "./transition.ts";

const expected: readonly (Omit<ExternalTransition, "trigger"> & {
  trigger: string;
})[] = [
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
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "claim-released",
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
    to: "ready",
    trigger: "claim-expired",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "daemon",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "attempt-failed",
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
    to: "ready",
    trigger: "report-cancelled",
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
];

function rowByTrigger(trigger: string): ExternalTransition {
  const row = externalTransitions.find((entry) => entry.trigger === trigger);
  assert.ok(row, `no row for trigger ${trigger}`);
  return row;
}

describe("src/domain/external-transition.test", () => {
  it("externalTransitions holds ten trigger ids", () => {
    assert.equal(externalTriggerIds.length, 10);
    assert.deepEqual(
      [...externalTriggerIds],
      [
        "attempt-rejected",
        "outcome-accepted",
        "attempt-limit-reached",
        "object-reported",
        "human-close",
        "human-close-partial",
        "claim-released",
        "claim-expired",
        "attempt-failed",
        "report-cancelled",
      ],
    );
    assert.equal(new Set(externalTriggerIds).size, 10);
  });

  it("externalTransitions holds exactly ten rows in exactly the declared order", () => {
    assert.equal(externalTransitions.length, 10);
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

  it("the claim-released row carries every ExternalPrecondition field", () => {
    assert.deepEqual(rowByTrigger("claim-released"), {
      level: "task",
      from: "running",
      to: "ready",
      trigger: "claim-released",
      precondition: {
        runDriver: "external",
        activeRun: true,
        leaseFence: "valid",
        actorKind: "harness",
        attemptLimit: "under",
        reportedObjectId: "absent",
        childAggregation: "not-applicable",
      },
    });
  });

  it("the claim-expired row carries every ExternalPrecondition field", () => {
    assert.deepEqual(rowByTrigger("claim-expired"), {
      level: "task",
      from: "running",
      to: "ready",
      trigger: "claim-expired",
      precondition: {
        runDriver: "external",
        activeRun: true,
        leaseFence: "none",
        actorKind: "daemon",
        attemptLimit: "under",
        reportedObjectId: "absent",
        childAggregation: "not-applicable",
      },
    });
    const released = rowByTrigger("claim-released").precondition;
    const expired = rowByTrigger("claim-expired").precondition;
    const differing = (
      Object.keys(released) as (keyof ExternalPrecondition)[]
    ).filter((key) => released[key] !== expired[key]);
    assert.deepEqual(differing, ["leaseFence", "actorKind"]);
  });

  it("both new rows name a legal matrix cell", () => {
    for (const trigger of ["claim-released", "claim-expired"] as const) {
      const row = rowByTrigger(trigger);
      assert.equal(row.level, "task");
      assert.equal(row.from, "running");
      assert.equal(row.to, "ready");
      assert.equal(canTransition(row.level, row.from, row.to), true);
    }
  });

  it("the attempt-failed row is field by field the failed report contract", () => {
    const row = rowByTrigger("attempt-failed");
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

  it("the report-cancelled row is field by field the cancelled report contract", () => {
    const row = rowByTrigger("report-cancelled");
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

  it("both new rows name a legal cell", () => {
    for (const trigger of ["attempt-failed", "report-cancelled"] as const) {
      const row = rowByTrigger(trigger);
      assert.equal(row.level, "task");
      assert.equal(row.from, "running");
      assert.equal(row.to, "ready");
      assert.equal(canTransition(row.level, row.from, row.to), true);
    }
  });

  it("the three initiative roll-up triggers are internal", () => {
    const external = externalTriggerIds as readonly string[];
    const internal = internalTriggerIds as readonly string[];
    for (const id of [
      "initiative-aggregated-done",
      "initiative-aggregated-partial",
      "initiative-aggregated-discarded",
    ] as const) {
      assert.ok(
        !external.includes(id),
        `${id} must stay out of the external table`,
      );
      assert.ok(internal.includes(id), `${id} must stay internal`);
    }
    for (const to of ["done", "partial", "discarded"] as const) {
      assert.equal(canTransition("initiative", "running", to), true);
    }
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
    it("is total over the ten trigger ids", () => {
      const keys = Object.keys(externalTriggerConsumer);
      assert.equal(keys.length, 10);
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

    it("the two new triggers name report-outcome.ts", () => {
      const consumer = externalTriggerConsumer as Readonly<
        Record<string, string | undefined>
      >;
      assert.equal(
        consumer["attempt-failed"],
        "src/commands/outcome/report-outcome.ts",
      );
      assert.equal(
        consumer["report-cancelled"],
        "src/commands/outcome/report-outcome.ts",
      );
    });

    it("claim-released names the release command and claim-expired names the sweep", () => {
      assert.equal(
        externalTriggerConsumer["claim-released"],
        "src/commands/node/release-node.ts",
      );
      assert.equal(
        externalTriggerConsumer["claim-expired"],
        "src/commands/startup/recover-expired-leases.ts",
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
        "attempt-failed",
        "report-cancelled",
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

  describe("externalTriggerConsumer on disk", () => {
    const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

    it("every consumer path exists on disk", () => {
      for (const [trigger, path] of Object.entries(externalTriggerConsumer)) {
        assert.ok(
          existsSync(resolve(repoRoot, path)),
          `${trigger}: ${path} is absent`,
        );
      }
    });

    it("every consumer file holds its own trigger id as a literal", () => {
      for (const [trigger, path] of Object.entries(externalTriggerConsumer)) {
        const content = readFileSync(resolve(repoRoot, path), "utf8");
        assert.ok(
          content.includes(`"${trigger}"`),
          `${trigger} is not a literal of ${path}`,
        );
      }
    });

    it("no consumer path names aggregate-objective", () => {
      for (const value of Object.values(externalTriggerConsumer)) {
        assert.notEqual(value, "src/commands/outcome/aggregate-objective.ts");
        assert.ok(
          !value.includes("src/commands/outcome/aggregate-objective.ts"),
        );
      }
      assert.equal(
        existsSync(
          resolve(repoRoot, "src/commands/outcome/aggregate-objective.ts"),
        ),
        false,
      );
    });

    it("the assertion read at least one file", () => {
      const files = new Set(Object.values(externalTriggerConsumer));
      for (const path of files) {
        readFileSync(resolve(repoRoot, path), "utf8");
      }
      assert.equal(
        files.size,
        new Set(Object.values(externalTriggerConsumer)).size,
      );
      assert.ok(files.size > 0);
    });
  });
});
