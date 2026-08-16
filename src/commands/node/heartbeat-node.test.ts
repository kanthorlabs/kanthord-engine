import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { sweepExpiredExternalLeases } from "../startup/recover-expired-leases.ts";
import { claimNode, type ClaimNodeResult } from "./claim-node.ts";
import {
  heartbeatNode,
  HeartbeatNodeError,
  type HeartbeatNodeResult,
} from "./heartbeat-node.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createMigratedStorage,
  databaseBytes,
} from "../../../test/helpers/database.ts";
import {
  createBackedExecutionFake,
  type BackedExecutionFake,
} from "../../../test/helpers/execution.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  createBackedLeaseFake,
  type BackedLeaseFake,
} from "../../../test/helpers/lease.ts";
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
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
const ACTOR_B = "actor_beta";
const ATTEMPT_LIMIT = 3;

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sequenceUlids(length: number): readonly string[] {
  return Array.from({ length }, (_, index) => {
    let value = index;
    let ulid = "";
    for (let position = 0; position < 26; position++) {
      ulid = ULID_ALPHABET[value % 32]! + ulid;
      value = Math.floor(value / 32);
    }
    return ulid;
  });
}

type HeartbeatFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  dispose(): void;
}>;

function createFixture(): HeartbeatFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const events: EventLog = new SqliteEventLog({
    storage,
    ids: createMockIdGenerator({ ulids: sequenceUlids(64) }),
  });
  const execution = createBackedExecutionFake({
    ids: createMockIdGenerator({ ulids: sequenceUlids(32) }),
  });
  const plan = createRecordingPlanStore(
    createPlanStore(createReadiness(events, INSTANCE)),
  );
  return {
    storage,
    plan,
    lease: createBackedLeaseFake(),
    execution,
    events,
    dispose() {
      temporary.dispose();
    },
  };
}

function seedReadyGraph(fixture: HeartbeatFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

function claim(
  fixture: HeartbeatFixture,
  clock: Clock,
  actorId: string,
): ClaimNodeResult {
  return claimNode(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
      ids: createMockIdGenerator({ ulids: [] }),
      sweepExpiredExternalLeases: (
        transaction: Transaction,
        input: Readonly<{ actor: string; now: number }>,
      ) => {
        sweepExpiredExternalLeases(
          {
            plan: fixture.plan.plan,
            lease: fixture.lease.lease,
            execution: fixture.execution.execution,
            events: fixture.events,
          },
          transaction,
          input,
        );
      },
      attemptLimit: ATTEMPT_LIMIT,
      leaseTtlMs: TTL,
      instanceId: INSTANCE,
    },
    {
      nodeId: fixtureIds.task,
      actorId,
      actorKind: "harness",
    },
  );
}

function beat(
  fixture: HeartbeatFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; fence: number; actorId: string }>,
): HeartbeatNodeResult {
  return heartbeatNode(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      events: fixture.events,
      clock,
      leaseTtlMs: TTL,
    },
    {
      nodeId: input.nodeId,
      fence: input.fence,
      actorId: input.actorId,
      actorKind: "harness",
    },
  );
}

function refused(
  fixture: HeartbeatFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; fence: number; actorId: string }>,
): HeartbeatNodeError {
  let raised: unknown;
  try {
    beat(fixture, clock, input);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof HeartbeatNodeError,
    `expected HeartbeatNodeError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: HeartbeatFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function leaseRows(fixture: HeartbeatFixture): readonly Readonly<{
  subject_id: string;
  owner: string | null;
  owner_kind: string | null;
  fence: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      `SELECT subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = 'node'
ORDER BY subject_id`,
    ),
  ) as readonly Readonly<{
    subject_id: string;
    owner: string | null;
    owner_kind: string | null;
    fence: number;
    acquired_at: number | null;
    renewed_at: number | null;
    expires_at: number | null;
  }>[];
}

describe("src/commands/node/heartbeat-node.test", () => {
  it("a heartbeat with the current fence extends expires_at on both the task lease and the objective lease", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const now2 = NOW + 10000;
    const result = beat(fixture, createMockClock({ start: now2 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(result.lease.expiresAt, now2 + TTL);
    assert.equal(result.objectiveLease.expiresAt, now2 + TTL);
    const leases = leaseRows(fixture);
    const taskLease = leases.find((row) => row.subject_id === fixtureIds.task);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(taskLease !== undefined);
    assert.ok(objectiveLease !== undefined);
    assert.equal(taskLease.expires_at, now2 + TTL);
    assert.equal(objectiveLease.expires_at, now2 + TTL);
  });

  it("a heartbeat leaves both fences unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    beat(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const leases = leaseRows(fixture);
    const taskLease = leases.find((row) => row.subject_id === fixtureIds.task);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(taskLease !== undefined);
    assert.ok(objectiveLease !== undefined);
    assert.equal(taskLease.fence, 1);
    assert.equal(objectiveLease.fence, 1);
  });

  it("a heartbeat with any other fence is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = leaseRows(fixture);
    const eventsBefore = fixture.events.list({}).length;
    const error = refused(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.task,
      fence: 2,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(leaseRows(fixture), before);
    assert.equal(fixture.events.list({}).length, eventsBefore);
  });

  it("a heartbeat by another owner is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = leaseRows(fixture);
    const error = refused(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(leaseRows(fixture), before);
  });

  it("a heartbeat moves no node", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const callsBefore = fixture.plan.calls.length;
    beat(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(fixture.plan.calls.length, callsBefore);
    assert.equal(nodeState(fixture, fixtureIds.task), "running");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
  });

  it("a heartbeat on an objective renews the objective lease only", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = leaseRows(fixture);
    const now2 = NOW + 10000;
    const result = beat(fixture, createMockClock({ start: now2 }), {
      nodeId: fixtureIds.objective,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(result.lease.subjectId, fixtureIds.objective);
    const leases = leaseRows(fixture);
    const taskLease = leases.find((row) => row.subject_id === fixtureIds.task);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(taskLease !== undefined);
    assert.ok(objectiveLease !== undefined);
    assert.deepEqual(
      taskLease,
      before.find((row) => row.subject_id === fixtureIds.task),
    );
    assert.equal(objectiveLease.expires_at, now2 + TTL);
  });

  it("a heartbeat appends one lease.renewed event", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const now2 = NOW + 10000;
    beat(fixture, createMockClock({ start: now2 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const events = fixture.events
      .list({})
      .filter((event) => event.type === "lease.renewed");
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.subjectKind, "node");
    assert.equal(event.subjectId, fixtureIds.task);
    assert.equal(event.actorKind, "harness");
    assert.equal(event.actorId, ACTOR_A);
    const payload = event.payload as Readonly<Record<string, unknown>>;
    assert.equal(payload.subjectId, fixtureIds.task);
    assert.equal(payload.objectiveId, fixtureIds.objective);
    assert.equal(payload.fence, 1);
    assert.equal(payload.objectiveFence, 1);
    assert.equal(payload.expiresAt, now2 + TTL);
    assert.equal(payload.objectiveExpiresAt, now2 + TTL);
  });

  it("a heartbeat on an unknown node is refused node-not-found", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: "task_absent",
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "node-not-found");
  });

  it("a heartbeat on an initiative is refused initiative-not-claimable and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.initiative,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "initiative-not-claimable");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a heartbeat whose objective lease is absent or free is refused lease-held and writes nothing", (t) => {
    for (const scenario of ["absent", "free"] as const) {
      const fixture = createFixture();
      t.after(() => fixture.dispose());
      seedReadyGraph(fixture);
      claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
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
      const before = leaseRows(fixture);
      const eventsBefore = fixture.events.list({}).length;
      const error = refused(fixture, createMockClock({ start: NOW + 10000 }), {
        nodeId: fixtureIds.task,
        fence: 1,
        actorId: ACTOR_A,
      });
      assert.equal(error.refusal, "lease-held");
      assert.deepEqual(leaseRows(fixture), before);
      assert.equal(fixture.events.list({}).length, eventsBefore);
    }
  });

  it("a heartbeat whose own holding has expired is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = leaseRows(fixture);
    const eventsBefore = fixture.events.list({}).length;
    const error = refused(fixture, createMockClock({ start: NOW + TTL + 1 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(leaseRows(fixture), before);
    assert.equal(fixture.events.list({}).length, eventsBefore);
  });

  it("heartbeatIntervalMs is one third of leaseTtlMs", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const result = beat(fixture, createMockClock({ start: NOW + 10000 }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(result.heartbeatIntervalMs, 100000);
  });
});
