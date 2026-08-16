import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { externalTransitions } from "../../domain/external-transition.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { sweepExpiredExternalLeases } from "../startup/recover-expired-leases.ts";
import {
  claimNode,
  ClaimNodeError,
  type ClaimNodeResult,
} from "./claim-node.ts";
import { heartbeatNode } from "./heartbeat-node.ts";
import {
  releaseNode,
  ReleaseNodeError,
  type ReleaseNodeResult,
} from "./release-node.ts";
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

type ReleaseFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  dispose(): void;
}>;

function createFixture(): ReleaseFixture {
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

function seedReadyGraph(fixture: ReleaseFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

function claim(
  fixture: ReleaseFixture,
  clock: Clock,
  actorId: string,
  nodeId: string = fixtureIds.task,
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
      nodeId,
      actorId,
      actorKind: "harness",
    },
  );
}

function release(
  fixture: ReleaseFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; fence: number; actorId: string }>,
): ReleaseNodeResult {
  return releaseNode(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
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
  fixture: ReleaseFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; fence: number; actorId: string }>,
): ReleaseNodeError {
  let raised: unknown;
  try {
    release(fixture, clock, input);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof ReleaseNodeError,
    `expected ReleaseNodeError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: ReleaseFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function everyNodeState(fixture: ReleaseFixture): readonly string[] {
  return fixture.storage.transact((transaction) =>
    transaction
      .all("SELECT state FROM node ORDER BY id")
      .map((row) => (row as Readonly<{ state: string }>).state),
  );
}

function setNodeStateCalls(
  fixture: ReleaseFixture,
): readonly SetNodeStateInput[] {
  return fixture.plan.calls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

function runRows(fixture: ReleaseFixture): readonly Readonly<{
  id: string;
  kind: string;
  node_id: string;
  parent_run_id: string | null;
  state: string;
  outcome: string | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      `SELECT id, kind, node_id, parent_run_id, state, outcome
FROM run
ORDER BY id`,
    ),
  ) as readonly Readonly<{
    id: string;
    kind: string;
    node_id: string;
    parent_run_id: string | null;
    state: string;
    outcome: string | null;
  }>[];
}

function attemptRows(fixture: ReleaseFixture): readonly Readonly<{
  id: string;
  run_id: string;
  outcome: string | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all("SELECT id, run_id, outcome FROM attempt ORDER BY id"),
  ) as readonly Readonly<{
    id: string;
    run_id: string;
    outcome: string | null;
  }>[];
}

function leaseRows(fixture: ReleaseFixture): readonly Readonly<{
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

type MutableClock = Readonly<{
  clock: Clock;
  advance(ms: number): void;
}>;

function createMutableClock(): MutableClock {
  let current = NOW;
  return {
    clock: {
      now(): number {
        return current;
      },
    },
    advance(ms: number): void {
      current += ms;
    },
  };
}

describe("src/commands/node/release-node.test", () => {
  it("a task release with the current fence frees the task lease, moves the task to ready, and leaves the fence unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const result = release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(result.node.state, "ready");
    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
    const leases = leaseRows(fixture);
    const taskLease = leases.find((row) => row.subject_id === fixtureIds.task);
    assert.ok(taskLease !== undefined);
    assert.equal(taskLease.owner, null);
    assert.equal(taskLease.owner_kind, null);
    assert.equal(taskLease.fence, 1);
    assert.equal(taskLease.acquired_at, null);
    assert.equal(taskLease.renewed_at, null);
    assert.equal(taskLease.expires_at, null);
  });

  it("a task release leaves the objective lease held and the objective run active", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const leases = leaseRows(fixture);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(objectiveLease !== undefined);
    assert.equal(objectiveLease.owner, ACTOR_A);
    assert.equal(objectiveLease.expires_at, NOW + TTL);
    const runs = runRows(fixture);
    const objectiveRun = runs.find((row) => row.kind === "objective");
    assert.ok(objectiveRun !== undefined);
    assert.equal(objectiveRun.state, "active");
    let raised: unknown;
    try {
      claim(
        fixture,
        createMockClock({ start: NOW }),
        ACTOR_B,
        fixtureIds.objective,
      );
    } catch (error) {
      raised = error;
    }
    assert.ok(raised instanceof ClaimNodeError);
    assert.equal(raised.refusal, "lease-held");
  });

  it("a task release closes the attempt cancelled and ends the run released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const attempts = attemptRows(fixture);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "cancelled");
    const runs = runRows(fixture);
    const taskRun = runs.find((row) => row.kind === "task");
    assert.ok(taskRun !== undefined);
    assert.equal(taskRun.state, "ended");
    assert.equal(taskRun.outcome, "released");
  });

  it("a task release records trigger claim-released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const callsBefore = setNodeStateCalls(fixture).length;
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const calls = setNodeStateCalls(fixture).slice(callsBefore);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      id: fixtureIds.task,
      from: "running",
      to: "ready",
      trigger: "claim-released",
      blockReason: null,
      at: NOW,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });

  it("a task release with a wrong fence or a wrong owner is refused and writes nothing", (t) => {
    for (const scenario of ["fence", "owner"] as const) {
      const fixture = createFixture();
      t.after(() => fixture.dispose());
      seedReadyGraph(fixture);
      claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
      const before = databaseBytes(fixture.storage);
      const eventsBefore = fixture.events.list({}).length;
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        fence: scenario === "fence" ? 2 : 1,
        actorId: scenario === "owner" ? ACTOR_B : ACTOR_A,
      });
      assert.equal(error.refusal, "lease-held");
      assert.deepEqual(databaseBytes(fixture.storage), before);
      assert.equal(fixture.events.list({}).length, eventsBefore);
    }
  });

  it("an objective release while a task lease under it is live is refused lease-held and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "lease-held");
    const details = error.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, fixtureIds.task);
    assert.equal(details.holder, ACTOR_A);
    assert.equal(details.relation, "descendant");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("an objective release after every task release frees the objective lease and ends the objective run released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: 1,
      actorId: ACTOR_A,
    });
    const leases = leaseRows(fixture);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(objectiveLease !== undefined);
    assert.equal(objectiveLease.owner, null);
    assert.equal(objectiveLease.expires_at, null);
    const runs = runRows(fixture);
    const objectiveRun = runs.find((row) => row.kind === "objective");
    assert.ok(objectiveRun !== undefined);
    assert.equal(objectiveRun.state, "ended");
    assert.equal(objectiveRun.outcome, "released");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
  });

  it("an objective release writes no objective node state", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const objectiveCallsBefore = setNodeStateCalls(fixture).filter(
      (input) => input.id === fixtureIds.objective,
    ).length;
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: 1,
      actorId: ACTOR_A,
    });
    const objectiveCallsAfter = setNodeStateCalls(fixture).filter(
      (input) => input.id === fixtureIds.objective,
    ).length;
    assert.equal(objectiveCallsAfter, objectiveCallsBefore);
  });

  it("an initiative release is refused initiative-not-claimable and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "initiative-not-claimable");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a stale release is refused lease-held and not no-open-attempt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "lease-held");
    assert.notEqual(error.refusal, "no-open-attempt");
    assert.notEqual(error.refusal, "run-not-active");
  });

  it("a release whose run has no open attempt is refused no-open-attempt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    assert.ok(claimed.attemptId !== null);
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.closeAttempt(transaction, {
        attemptId: claimed.attemptId!,
        outcome: "cancelled",
        at: NOW,
      });
    });
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "no-open-attempt");
  });

  it("a release result carries the node view", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const result = release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: 1,
      actorId: ACTOR_A,
    });
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(result.node.state, "ready");
  });

  it("no path of this epic writes awaiting_approval", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const clock = createMutableClock();

    const claimed = claim(fixture, clock.clock, ACTOR_A);
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    clock.advance(10000);
    heartbeatNode(
      {
        storage: fixture.storage,
        plan: fixture.plan.plan,
        lease: fixture.lease.lease,
        events: fixture.events,
        clock: clock.clock,
        leaseTtlMs: TTL,
      },
      {
        nodeId: fixtureIds.task,
        fence: claimed.lease.fence,
        actorId: ACTOR_A,
        actorKind: "harness",
      },
    );
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    clock.advance(10000);
    release(fixture, clock.clock, {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      actorId: ACTOR_A,
    });
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    clock.advance(10000);
    claim(fixture, clock.clock, ACTOR_A);
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    clock.advance(TTL + 1000);
    fixture.storage.transact((transaction) => {
      sweepExpiredExternalLeases(
        {
          plan: fixture.plan.plan,
          lease: fixture.lease.lease,
          execution: fixture.execution.execution,
          events: fixture.events,
        },
        transaction,
        { actor: INSTANCE, now: clock.clock.now() },
      );
    });
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    claim(fixture, clock.clock, ACTOR_A);
    for (const state of everyNodeState(fixture)) {
      assert.notEqual(state, "awaiting_approval");
    }

    for (const trigger of ["claim-released", "claim-expired"] as const) {
      const row = externalTransitions.find(
        (candidate) => candidate.trigger === trigger,
      );
      assert.ok(row !== undefined, `no external transition row for ${trigger}`);
      assert.notEqual(row.to, "awaiting_approval");
    }
  });
});
