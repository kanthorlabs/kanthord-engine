import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { expireRuns } from "./expire-runs.ts";
import { RenewRunError, renewRun } from "./renew-run.ts";
import type { EventLog } from "../../services/event/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import {
  createMigratedStorage,
  databaseBytes,
  type TemporaryStorage,
} from "../../../test/helpers/database.ts";
import { createBackedExecutionFake } from "../../../test/helpers/execution.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createBackedLeaseFake } from "../../../test/helpers/lease.ts";
import {
  createPlanStore,
  createReadiness,
  createRecordingPlanStore,
} from "../../../test/helpers/plan.ts";
import {
  fixtureIds,
  seedGraph,
  seedNodeState,
  seedRegistry,
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const RUN_ID = "run_renew";
const ACTOR = "actor_alpha";
const RUN_TTL_MS = 300000;
const LEASE_TTL_MS = 300000;
const INSTANCE = "daemon_instance_a";

type RenewFixture = Readonly<{
  temporary: TemporaryStorage;
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: ReturnType<typeof createBackedLeaseFake>;
  execution: ReturnType<typeof createBackedExecutionFake>;
  events: EventLog;
}>;

function createFixture(): RenewFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const events: EventLog = new SqliteEventLog({
    storage,
    ids: createMockIdGenerator({
      ulids: [
        "00000000000000000000000000",
        "00000000000000000000000001",
        "00000000000000000000000002",
      ],
    }),
  });
  const execution = createBackedExecutionFake({
    ids: createMockIdGenerator({ ulids: [] }),
  });
  const plan = createRecordingPlanStore(
    createPlanStore(createReadiness(events, INSTANCE)),
  );
  const lease = createBackedLeaseFake();
  return { temporary, storage, plan, lease, execution, events };
}

const OBJECTIVE_RUN_ID = "run_renew_objective";

function seedObjectiveRun(
  storage: Storage,
  expiresAt = NOW + 1000,
  maxLifetimeAt = NOW + 900000,
): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        OBJECTIVE_RUN_ID,
        "structural",
        fixtureIds.objective,
        "external",
        null,
        "claude@1",
        1,
        3,
        null,
        null,
        fixtureIds.planRevision,
        "[]",
        expiresAt,
        maxLifetimeAt,
        "active",
        null,
        null,
      ],
    );
  });
}

function runExpiry(storage: Storage, runId: string): number {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT expires_at FROM run WHERE id = ?", [runId]),
  ) as Readonly<{ expires_at: number }> | undefined;
  assert.ok(row !== undefined);
  return row.expires_at;
}

type ObjectiveRunSeed = Readonly<{
  expiresAt: number;
  maxLifetimeAt: number;
}> | null;

function seedFixture(
  storage: Storage,
  maxLifetimeAt = NOW + 900000,
  runNodeId: string = fixtureIds.task,
  runFence = 3,
  objectiveRun: ObjectiveRunSeed | undefined = undefined,
): void {
  const objective =
    objectiveRun === undefined
      ? runNodeId === fixtureIds.task
        ? { expiresAt: NOW + 1000, maxLifetimeAt: NOW + 900000 }
        : null
      : objectiveRun;
  storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "running");
    seedNodeState(transaction, fixtureIds.objective, "running");
    seedNodeState(transaction, fixtureIds.task, "running");
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "node",
        fixtureIds.objective,
        ACTOR,
        "actor",
        1,
        NOW,
        NOW,
        NOW + LEASE_TTL_MS,
      ],
    );
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "node",
        fixtureIds.task,
        ACTOR,
        "actor",
        1,
        NOW,
        NOW,
        NOW + LEASE_TTL_MS,
      ],
    );
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        RUN_ID,
        "execution",
        runNodeId,
        "external",
        null,
        "claude@1",
        runFence,
        3,
        null,
        null,
        fixtureIds.planRevision,
        "[]",
        NOW + 1000,
        maxLifetimeAt,
        "active",
        null,
        null,
      ],
    );
  });
  if (objective !== null) {
    seedObjectiveRun(storage, objective.expiresAt, objective.maxLifetimeAt);
  }
}

function renew(
  fixture: RenewFixture,
  nodeId: string = fixtureIds.task,
  runFence = 3,
  runId = RUN_ID,
  expiryPass = true,
  fence = 1,
  actorId = ACTOR,
): unknown {
  return renewRun(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock: { now: () => NOW },
      expiry: {
        expireRuns(transaction, input) {
          if (!expiryPass) {
            return [];
          }
          return expireRuns(
            {
              events: fixture.events,
              execution: fixture.execution.execution,
              instanceId: INSTANCE,
            },
            transaction,
            input,
          );
        },
      },
      leaseTtlMs: LEASE_TTL_MS,
      runTtlMs: RUN_TTL_MS,
      caller: "claude@1",
    },
    {
      nodeId,
      fence,
      runId,
      runFence,
      actorId,
      actorKind: "harness",
    },
  );
}

function refused(
  fixture: RenewFixture,
  runFence: number,
  nodeId: string = fixtureIds.task,
  runId = RUN_ID,
  expiryPass = true,
  fence = 1,
  actorId = ACTOR,
): RenewRunError {
  let raised: unknown;
  try {
    renew(fixture, nodeId, runFence, runId, expiryPass, fence, actorId);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof RenewRunError,
    `expected RenewRunError, got ${String(raised)}`,
  );
  return raised;
}

function sweep(fixture: RenewFixture, now: number): void {
  fixture.storage.transact((transaction) => {
    expireRuns(
      {
        events: fixture.events,
        execution: fixture.execution.execution,
        instanceId: INSTANCE,
      },
      transaction,
      { now },
    );
  });
}

function runRow(
  storage: Storage,
  runId: string,
): Readonly<{ state: string; fence: number; expires_at: number }> {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT state, fence, expires_at FROM run WHERE id = ?", [
      runId,
    ]),
  ) as
    Readonly<{ state: string; fence: number; expires_at: number }> | undefined;
  assert.ok(row !== undefined);
  return row;
}

function runIdsOfNode(storage: Storage, nodeId: string): readonly string[] {
  return (
    storage.transact((transaction) =>
      transaction.all("SELECT id FROM run WHERE node_id = ? ORDER BY id", [
        nodeId,
      ]),
    ) as readonly Readonly<{ id: string }>[]
  ).map((row) => row.id);
}

function leaseExpiry(storage: Storage, subjectId: string): number {
  const row = storage.transact((transaction) =>
    transaction.get(
      "SELECT expires_at FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [subjectId],
    ),
  ) as Readonly<{ expires_at: number }> | undefined;
  assert.ok(row !== undefined);
  return row.expires_at;
}

function leaseFence(storage: Storage, subjectId: string): number {
  const row = storage.transact((transaction) =>
    transaction.get(
      "SELECT fence FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
      [subjectId],
    ),
  ) as Readonly<{ fence: number }> | undefined;
  assert.ok(row !== undefined);
  return row.fence;
}

function nodeState(storage: Storage, nodeId: string): string {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT state FROM node WHERE id = ?", [nodeId]),
  ) as Readonly<{ state: string }> | undefined;
  assert.ok(row !== undefined);
  return row.state;
}

describe("src/commands/run/renew-run.test", () => {
  it("a successful renew leaves the fence unchanged and moves expires_at forward", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT fence, expires_at FROM run WHERE id = ?", [
        RUN_ID,
      ]),
    ) as Readonly<{ fence: number; expires_at: number }>;
    assert.equal(row.fence, 3);
    assert.equal(row.expires_at, NOW + RUN_TTL_MS);
  });

  it("a renew clamps expires_at to max_lifetime_at", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 1000);

    renew(fixture);

    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT expires_at FROM run WHERE id = ?", [RUN_ID]),
    ) as Readonly<{ expires_at: number }>;
    assert.equal(row.expires_at, NOW + 1000);
  });

  it("a renew one millisecond before max_lifetime_at succeeds", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 1);

    renew(fixture);

    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT expires_at FROM run WHERE id = ?", [RUN_ID]),
    ) as Readonly<{ expires_at: number }>;
    assert.equal(row.expires_at, NOW + 1);
  });

  it("a renew renews the objective lease with the node lease", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET expires_at = ? WHERE subject_kind = 'node' AND subject_id IN (?, ?)",
        [NOW + 1000, fixtureIds.objective, fixtureIds.task],
      );
    });

    const beforeTask = leaseExpiry(fixture.storage, fixtureIds.task);
    const beforeObjective = leaseExpiry(fixture.storage, fixtureIds.objective);

    renew(fixture);

    const afterTask = leaseExpiry(fixture.storage, fixtureIds.task);
    const afterObjective = leaseExpiry(fixture.storage, fixtureIds.objective);
    assert.equal(beforeTask, NOW + 1000);
    assert.equal(beforeObjective, NOW + 1000);
    assert.equal(afterTask, NOW + LEASE_TTL_MS);
    assert.equal(afterObjective, NOW + LEASE_TTL_MS);
    assert.ok(afterTask > beforeTask);
    assert.ok(afterObjective > beforeObjective);
  });

  it("a renew leaves both lease fences unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    assert.equal(leaseFence(fixture.storage, fixtureIds.task), 1);
    assert.equal(leaseFence(fixture.storage, fixtureIds.objective), 1);
  });

  it("a renew with another node lease fence is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;

    const error = refused(fixture, 3, fixtureIds.task, RUN_ID, true, 2);

    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(databaseBytes(fixture.storage), before);
    assert.equal(fixture.events.list({}).length, eventsBefore);
  });

  it("a renew whose node lease has another owner is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET owner = ?, owner_kind = 'actor' WHERE subject_kind = 'node' AND subject_id = ?",
        ["actor_other", fixtureIds.task],
      );
    });
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(databaseBytes(fixture.storage), before);
    assert.equal(fixture.events.list({}).length, eventsBefore);
  });

  it("a renew moves no node", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    assert.equal(nodeState(fixture.storage, fixtureIds.task), "running");
    assert.equal(nodeState(fixture.storage, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture.storage, fixtureIds.initiative), "running");
  });

  it("an objective renew renews the objective lease only", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.objective);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET expires_at = ? WHERE subject_kind = 'node' AND subject_id IN (?, ?)",
        [NOW + 1000, fixtureIds.objective, fixtureIds.task],
      );
    });

    const beforeTask = leaseExpiry(fixture.storage, fixtureIds.task);
    const beforeObjective = leaseExpiry(fixture.storage, fixtureIds.objective);

    const result = renew(fixture, fixtureIds.objective) as Readonly<{
      lease: Readonly<{ subjectId: string }>;
    }>;

    assert.equal(result.lease.subjectId, fixtureIds.objective);
    assert.equal(leaseExpiry(fixture.storage, fixtureIds.task), beforeTask);
    assert.equal(
      leaseExpiry(fixture.storage, fixtureIds.objective),
      NOW + LEASE_TTL_MS,
    );
    assert.ok(
      leaseExpiry(fixture.storage, fixtureIds.objective) > beforeObjective,
    );

    const renewCalls = fixture.lease.calls.filter(
      (call) => call.name === "renew",
    );
    assert.equal(renewCalls.length, 1);
    assert.equal(
      (renewCalls[0]!.input as Readonly<{ subjectId: string }>).subjectId,
      fixtureIds.objective,
    );
    assert.equal(
      fixture.lease.calls.filter((call) => call.name === "read").length,
      0,
    );
  });

  it("a renew whose objective lease is absent or free is refused lease-held and writes nothing", (t) => {
    for (const scenario of ["absent", "free"] as const) {
      const fixture = createFixture();
      t.after(() => fixture.temporary.dispose());
      seedFixture(fixture.storage);
      fixture.storage.transact((transaction) => {
        if (scenario === "absent") {
          transaction.run(
            "DELETE FROM lease WHERE subject_kind = 'node' AND subject_id = ?",
            [fixtureIds.objective],
          );
        } else {
          transaction.run(
            "UPDATE lease SET owner = NULL, owner_kind = NULL WHERE subject_kind = 'node' AND subject_id = ?",
            [fixtureIds.objective],
          );
        }
      });
      const before = databaseBytes(fixture.storage);
      const eventsBefore = fixture.events.list({}).length;

      const error = refused(fixture, 3);

      assert.equal(error.refusal, "lease-held");
      assert.deepEqual(databaseBytes(fixture.storage), before);
      assert.equal(fixture.events.list({}).length, eventsBefore);
    }
  });

  it("a renew whose own holding has expired is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET expires_at = ? WHERE subject_kind = 'node' AND subject_id = ?",
        [NOW - 1, fixtureIds.task],
      );
    });
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(databaseBytes(fixture.storage), before);
    assert.equal(fixture.events.list({}).length, eventsBefore);
  });

  it("a renew refuses a stale fence", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 4);
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "fence-stale");
    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT expires_at FROM run WHERE id = ?", [RUN_ID]),
    ) as Readonly<{ expires_at: number }>;
    assert.equal(row.expires_at, NOW + 1000);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a renew refuses an ended run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE run SET state = 'ended', ended_at = ? WHERE id = ?",
        [NOW, RUN_ID],
      );
    });

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "run-ended");
  });

  it("a renew on an expired run refuses and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run("UPDATE run SET expires_at = ? WHERE id = ?", [
        NOW - 1,
        RUN_ID,
      ]);
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "run-ended");
    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, fence, expires_at FROM run WHERE id = ?", [
        RUN_ID,
      ]),
    ) as Readonly<{ state: string; fence: number; expires_at: number }>;
    assert.equal(row.state, "active");
    assert.equal(row.fence, 3);
    assert.equal(row.expires_at, NOW - 1);
    assert.deepEqual(
      fixture.events.list({ type: "run.expired", subject: RUN_ID }),
      [],
    );
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a renew on an unknown node refuses node-not-found, not target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    const error = refused(fixture, 3, "task_zzz");

    assert.equal(error.refusal, "node-not-found");
    assert.notEqual(error.refusal, "target-outside-run");
  });

  it("a renew on an initiative refuses initiative-not-claimable, not target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    const error = refused(fixture, 3, fixtureIds.initiative);

    assert.equal(error.refusal, "initiative-not-claimable");
    assert.notEqual(error.refusal, "target-outside-run");
  });

  it("a renew refuses a target outside the run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => seedSiblingTask(transaction));

    const error = refused(fixture, 3, "task_b");

    assert.equal(error.refusal, "target-outside-run");
  });

  it("a task renew moves the objective run forward with the task run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    assert.equal(runExpiry(fixture.storage, RUN_ID), NOW + RUN_TTL_MS);
    assert.equal(
      runExpiry(fixture.storage, OBJECTIVE_RUN_ID),
      NOW + RUN_TTL_MS,
    );
  });

  it("a task renew clamps the objective run to the objective run's own max_lifetime_at", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, {
      expiresAt: NOW + 1000,
      maxLifetimeAt: NOW + 2000,
    });

    renew(fixture);

    assert.equal(runExpiry(fixture.storage, RUN_ID), NOW + RUN_TTL_MS);
    assert.equal(runExpiry(fixture.storage, OBJECTIVE_RUN_ID), NOW + 2000);
  });

  it("a task renew appends one run.renewed per run it moved", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    assert.deepEqual(
      fixture.events
        .list({})
        .filter((event) => event.type === "run.renewed")
        .map((event) => event.subjectId),
      [RUN_ID, OBJECTIVE_RUN_ID],
    );
  });

  it("an objective renew moves its own run only", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.objective);

    renew(fixture, fixtureIds.objective);

    assert.deepEqual(
      fixture.events
        .list({})
        .filter((event) => event.type === "run.renewed")
        .map((event) => event.subjectId),
      [RUN_ID],
    );
  });

  it("a renew on a task presenting the objective run refuses target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.objective);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "target-outside-run");
  });

  it("a renew on the objective presenting the objective run is admitted", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.objective);

    const result = renew(fixture, fixtureIds.objective) as Readonly<{
      expiresAt: number;
    }>;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
  });

  it("a renew refusal carries only the run id", (t) => {
    type AuthorityRefusal =
      | "run-not-found"
      | "run-ended"
      | "run-expired"
      | "run-caller-mismatch"
      | "target-outside-run"
      | "fence-stale";

    const scenarios: readonly Readonly<{
      refusal: AuthorityRefusal;
      nodeId: string;
      runId: string;
      runFence: number;
      storedFence: number;
      expiryPass: boolean;
      prepare(fixture: RenewFixture): void;
    }>[] = [
      {
        refusal: "run-not-found",
        nodeId: fixtureIds.task,
        runId: "run_missing",
        runFence: 3,
        storedFence: 3,
        expiryPass: true,
        prepare() {},
      },
      {
        refusal: "run-ended",
        nodeId: fixtureIds.task,
        runId: RUN_ID,
        runFence: 3,
        storedFence: 3,
        expiryPass: true,
        prepare(fixture) {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE run SET state = 'ended' WHERE id = ?", [
              RUN_ID,
            ]);
          });
        },
      },
      {
        refusal: "run-expired",
        nodeId: fixtureIds.task,
        runId: RUN_ID,
        runFence: 3,
        storedFence: 3,
        expiryPass: false,
        prepare(fixture) {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE run SET expires_at = ? WHERE id = ?", [
              NOW - 1,
              RUN_ID,
            ]);
          });
        },
      },
      {
        refusal: "run-caller-mismatch",
        nodeId: fixtureIds.task,
        runId: RUN_ID,
        runFence: 3,
        storedFence: 3,
        expiryPass: true,
        prepare(fixture) {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE run SET worker = ? WHERE id = ?", [
              "actor_other",
              RUN_ID,
            ]);
          });
        },
      },
      {
        refusal: "target-outside-run",
        nodeId: "task_b",
        runId: RUN_ID,
        runFence: 3,
        storedFence: 3,
        expiryPass: true,
        prepare(fixture) {
          fixture.storage.transact((transaction) =>
            seedSiblingTask(transaction),
          );
        },
      },
      {
        refusal: "fence-stale",
        nodeId: fixtureIds.task,
        runId: RUN_ID,
        runFence: 3,
        storedFence: 4,
        expiryPass: true,
        prepare() {},
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createFixture();
      t.after(() => fixture.temporary.dispose());
      seedFixture(
        fixture.storage,
        NOW + 900000,
        fixtureIds.task,
        scenario.storedFence,
      );
      scenario.prepare(fixture);

      const error = refused(
        fixture,
        scenario.runFence,
        scenario.nodeId,
        scenario.runId,
        scenario.expiryPass,
      );

      assert.equal(error.refusal, scenario.refusal);
      assert.deepEqual(Object.keys(error.details!), ["runId"]);
      assert.equal(error.details?.runId, scenario.runId);
    }
  });

  it("the renew response carries expiresAt and renewAfterMs and no heartbeatIntervalMs", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    const result = renew(fixture) as Readonly<Record<string, unknown>>;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
    assert.equal(result.renewAfterMs, Math.floor(RUN_TTL_MS / 3));
    assert.equal(Object.hasOwn(result, "heartbeatIntervalMs"), false);
  });

  it("a renew appends exactly one run.renewed event and no lease.renewed", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);

    renew(fixture);

    const renewedEvents = fixture.events.list({
      subject: RUN_ID,
      type: "run.renewed",
    });
    assert.equal(renewedEvents.length, 1);
    assert.deepEqual(renewedEvents[0]?.payload, {
      runId: RUN_ID,
      nodeId: fixtureIds.task,
      fence: 3,
      expiresAt: NOW + RUN_TTL_MS,
    });
    assert.deepEqual(fixture.events.list({ type: "lease.renewed" }), []);
  });

  it("a renew at exactly max_lifetime_at refuses lifetime-exceeded and leaves expires_at unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lifetime-exceeded");
    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT expires_at FROM run WHERE id = ?", [RUN_ID]),
    ) as Readonly<{ expires_at: number }>;
    assert.equal(row.expires_at, NOW + 1000);
  });

  it("a renew past max_lifetime_at refuses", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW - 1);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lifetime-exceeded");
  });

  it("a lifetime-exceeded refusal leaves the database byte-identical", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW);
    const before = databaseBytes(fixture.storage);
    const beforeTask = leaseExpiry(fixture.storage, fixtureIds.task);
    const beforeObjective = leaseExpiry(fixture.storage, fixtureIds.objective);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lifetime-exceeded");
    assert.equal(leaseExpiry(fixture.storage, fixtureIds.task), beforeTask);
    assert.equal(
      leaseExpiry(fixture.storage, fixtureIds.objective),
      beforeObjective,
    );
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a stale fence at the lifetime boundary reports fence-stale", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW);

    const error = refused(fixture, 2);

    assert.equal(error.refusal, "fence-stale");
  });

  it("an initiative at the lifetime boundary reports initiative-not-claimable", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW);

    const error = refused(fixture, 3, fixtureIds.initiative);

    assert.equal(error.refusal, "initiative-not-claimable");
  });

  it("a lifetime-exceeded refusal carries only the run id", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "lifetime-exceeded");
    assert.deepEqual(Object.keys(error.details!), ["runId"]);
    assert.equal(error.details?.runId, RUN_ID);
  });

  it("a renew one millisecond before max_lifetime_at does not refuse", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 1);

    const result = renew(fixture) as Readonly<Record<string, unknown>>;

    assert.equal(result.expiresAt, NOW + 1);
    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT expires_at FROM run WHERE id = ?", [RUN_ID]),
    ) as Readonly<{ expires_at: number }>;
    assert.equal(row.expires_at, NOW + 1);
  });

  it("a renew announces the objective run's expiry as objectiveExpiresAt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, {
      expiresAt: NOW + 1000,
      maxLifetimeAt: NOW + 2000,
    });

    const result = renew(fixture) as Readonly<Record<string, unknown>>;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
    assert.equal(result.objectiveExpiresAt, NOW + 2000);
    assert.equal(
      result.objectiveExpiresAt,
      runExpiry(fixture.storage, OBJECTIVE_RUN_ID),
    );
    assert.notEqual(result.objectiveExpiresAt, result.expiresAt);
  });

  it("an objective renew reports its own expiry as objectiveExpiresAt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.objective);

    const result = renew(fixture, fixtureIds.objective) as Readonly<
      Record<string, unknown>
    >;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
    assert.equal(result.objectiveExpiresAt, NOW + RUN_TTL_MS);
    assert.equal(result.objectiveExpiresAt, result.expiresAt);
  });

  it("a task renew leaves an objective run at its own max_lifetime_at and still renews the task run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, {
      expiresAt: NOW + 1000,
      maxLifetimeAt: NOW + 1000,
    });

    const result = renew(fixture) as Readonly<Record<string, unknown>>;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
    assert.equal(runExpiry(fixture.storage, RUN_ID), NOW + RUN_TTL_MS);
    assert.equal(runExpiry(fixture.storage, OBJECTIVE_RUN_ID), NOW + 1000);
    assert.equal(result.objectiveExpiresAt, NOW + 1000);
  });

  it("the expiry pass after a lifetime-bound renew ends the objective run once and mints no replacement", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, {
      expiresAt: NOW + 1000,
      maxLifetimeAt: NOW + 1000,
    });
    renew(fixture);

    sweep(fixture, NOW + 2000);

    const objectiveRun = runRow(fixture.storage, OBJECTIVE_RUN_ID);
    assert.equal(objectiveRun.state, "ended");
    assert.equal(objectiveRun.expires_at, NOW + 1000);
    assert.equal(objectiveRun.fence, 2);
    assert.equal(runRow(fixture.storage, RUN_ID).state, "active");
    assert.deepEqual(
      fixture.events
        .list({})
        .filter((event) => event.type === "run.expired")
        .map((event) => event.subjectId),
      [OBJECTIVE_RUN_ID],
    );
    assert.deepEqual(runIdsOfNode(fixture.storage, fixtureIds.objective), [
      OBJECTIVE_RUN_ID,
    ]);
  });

  it("a task renew whose objective holds no active run is refused objective-run-lost and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, null);
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "objective-run-lost");
    assert.deepEqual(error.details, { objectiveId: fixtureIds.objective });
    assert.equal(runExpiry(fixture.storage, RUN_ID), NOW + 1000);
    assert.equal(fixture.events.list({}).length, eventsBefore);
    assert.deepEqual(databaseBytes(fixture.storage), before);

    const control = createFixture();
    t.after(() => control.temporary.dispose());
    seedFixture(control.storage);

    const result = renew(control) as Readonly<Record<string, unknown>>;

    assert.equal(result.expiresAt, NOW + RUN_TTL_MS);
    assert.equal(runExpiry(control.storage, RUN_ID), NOW + RUN_TTL_MS);
    assert.equal(
      runExpiry(control.storage, OBJECTIVE_RUN_ID),
      NOW + RUN_TTL_MS,
    );
  });

  it("a task renew whose objective run the expiry pass just ended is refused objective-run-lost and rolls the expiry back", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage, NOW + 900000, fixtureIds.task, 3, {
      expiresAt: NOW - 1,
      maxLifetimeAt: NOW + 900000,
    });
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "objective-run-lost");
    assert.deepEqual(error.details, { objectiveId: fixtureIds.objective });
    const objectiveRun = runRow(fixture.storage, OBJECTIVE_RUN_ID);
    assert.equal(objectiveRun.state, "active");
    assert.equal(objectiveRun.fence, 1);
    assert.equal(objectiveRun.expires_at, NOW - 1);
    assert.equal(runExpiry(fixture.storage, RUN_ID), NOW + 1000);
    assert.equal(fixture.events.list({}).length, eventsBefore);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("an ended objective run is refused objective-run-lost, not run-ended", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.temporary.dispose());
    seedFixture(fixture.storage);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE run SET state = 'ended', fence = 2, outcome = 'expired', ended_at = ? WHERE id = ?",
        [NOW - 1, OBJECTIVE_RUN_ID],
      );
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, 3);

    assert.equal(error.refusal, "objective-run-lost");
    assert.notEqual(error.refusal, "run-ended");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });
});
