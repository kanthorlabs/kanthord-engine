import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Clock } from "../../services/clock/index.ts";
import type { EventLog, RecordedEvent } from "../../services/event/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { sweepExpiredExternalLeases } from "../startup/recover-expired-leases.ts";
import {
  claimNode,
  ClaimNodeError,
  type ClaimNodeResult,
} from "./claim-node.ts";
import { reportOutcome } from "../outcome/report-outcome.ts";
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
  seedEmptyObjectiveGraph,
  seedGraph,
  seedNodeState,
  seedRegistry,
  seedRunRow,
  seedSecondProjectGraph,
  seedSecondRevisionWithTask,
  seedSiblingObjective,
  seedWorkspaceOnNode,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
const ACTOR_B = "actor_beta";
const ATTEMPT_LIMIT = 3;
const TASK_B = "task_b";
const REVISION_A = fixtureIds.planRevision;
const SIX_STATES = [
  "pending",
  "blocked",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;
const EMPTY_OBJECTIVE = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV";
const COMPLETE_OBJECTIVE = "objective_01FRZ3NDEKTSV4RRFFQ69G5FAW";

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

type ClaimFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  dispose(): void;
}>;

function createClaimFixture(): ClaimFixture {
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

function seedReadyFixture(fixture: ClaimFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

function seedReadySiblingFixture(fixture: ClaimFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedSecondRevisionWithTask(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
    seedNodeState(transaction, TASK_B, "ready");
  });
}

function seedSecondProjectFixture(fixture: ClaimFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedSecondProjectGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

function seedTaskLease(fixture: ClaimFixture): void {
  fixture.storage.transact((transaction) => {
    fixture.lease.lease.acquire(transaction, {
      subjectKind: "node",
      subjectId: fixtureIds.task,
      owner: ACTOR_A,
      ownerKind: "actor",
      ttlMs: TTL,
      now: NOW,
    });
  });
}

// Drives the real reportOutcome command of Story 7+8 to build the
// post-report state this story's fixtures need: the task back to `ready`,
// its run still active, its attempt closed with the reported outcome, the
// task lease free, and the objective lease still held by the reporting
// actor. The delegated objective commands throw, because a task report
// must never reach them.
function reportTaskOutcome(
  fixture: ClaimFixture,
  clock: Clock,
  input: Readonly<{
    nodeId: string;
    actorId: string;
    outcome: "rejected" | "failed" | "cancelled";
    fence: number;
  }>,
): void {
  reportOutcome(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
      reportObjective: () => {
        throw new Error("unexpected reportObjective call");
      },
      closeObjective: () => {
        throw new Error("unexpected closeObjective call");
      },
      instanceId: INSTANCE,
    },
    {
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: "harness",
      body: {
        report: input.outcome,
        fence: input.fence,
        reason: "fixture-driven report",
      },
    },
  );
}

type ClaimInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind?: "human" | "harness";
}>;

function claim(
  fixture: ClaimFixture,
  clock: Clock,
  input: ClaimInput,
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
        sweepInput: Readonly<{ actor: string; now: number }>,
      ) => {
        sweepExpiredExternalLeases(
          {
            plan: fixture.plan.plan,
            lease: fixture.lease.lease,
            execution: fixture.execution.execution,
            events: fixture.events,
          },
          transaction,
          sweepInput,
        );
      },
      attemptLimit: ATTEMPT_LIMIT,
      leaseTtlMs: TTL,
      instanceId: INSTANCE,
    },
    {
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: input.actorKind ?? "harness",
    },
  );
}

function refused(
  fixture: ClaimFixture,
  clock: Clock,
  input: ClaimInput,
): ClaimNodeError {
  let raised: unknown;
  try {
    claim(fixture, clock, input);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof ClaimNodeError,
    `expected ClaimNodeError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: ClaimFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function lastEvents(
  fixture: ClaimFixture,
  count: number,
): readonly RecordedEvent[] {
  const all = fixture.events.list({});
  return all.slice(-count);
}

function runningEvents(fixture: ClaimFixture): readonly RecordedEvent[] {
  return fixture.events
    .list({})
    .filter((event) => event.type === "node.running");
}

function setNodeStateCalls(
  fixture: ClaimFixture,
): readonly SetNodeStateInput[] {
  return fixture.plan.calls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

function runRows(fixture: ClaimFixture): readonly Readonly<{
  id: string;
  kind: string;
  node_id: string;
  parent_run_id: string | null;
  driver: string;
  workspace_id: string | null;
  worker: string | null;
  base_oid: string | null;
  lease_fence: number;
  state: string;
  outcome: string | null;
  ended_at: number | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      `SELECT id, kind, node_id, parent_run_id, driver, workspace_id, worker, base_oid, lease_fence, state, outcome, ended_at
FROM run
ORDER BY id`,
    ),
  ) as readonly Readonly<{
    id: string;
    kind: string;
    node_id: string;
    parent_run_id: string | null;
    driver: string;
    workspace_id: string | null;
    worker: string | null;
    base_oid: string | null;
    lease_fence: number;
    state: string;
    outcome: string | null;
    ended_at: number | null;
  }>[];
}

function attemptRows(fixture: ClaimFixture): readonly Readonly<{
  id: string;
  run_id: string;
  attempt_no: number;
  outcome: string | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      "SELECT id, run_id, attempt_no, outcome FROM attempt ORDER BY id",
    ),
  ) as readonly Readonly<{
    id: string;
    run_id: string;
    attempt_no: number;
    outcome: string | null;
  }>[];
}

function leaseRows(fixture: ClaimFixture): readonly Readonly<{
  subject_id: string;
  owner: string | null;
  fence: number;
  expires_at: number | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      "SELECT subject_id, owner, fence, expires_at FROM lease WHERE subject_kind = 'node' ORDER BY subject_id",
    ),
  ) as readonly Readonly<{
    subject_id: string;
    owner: string | null;
    fence: number;
    expires_at: number | null;
  }>[];
}

type MutableClock = Readonly<{
  clock: Clock;
  advance(ms: number): void;
  calls(): number;
}>;

function createMutableClock(): MutableClock {
  let current = NOW;
  let count = 0;
  return {
    clock: {
      now(): number {
        count++;
        return current;
      },
    },
    advance(ms: number): void {
      current += ms;
    },
    calls(): number {
      return count;
    },
  };
}

describe("src/commands/node/claim-node.test", () => {
  it("a claim on a ready task returns a lease and moves the task, the objective and the initiative to running", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.deepEqual(result.lease, {
      subjectId: fixtureIds.task,
      owner: ACTOR_A,
      ownerKind: "actor",
      fence: 1,
      expiresAt: NOW + TTL,
    });
    assert.deepEqual(result.objectiveLease, {
      subjectId: fixtureIds.objective,
      owner: ACTOR_A,
      ownerKind: "actor",
      fence: 1,
      expiresAt: NOW + TTL,
    });
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(result.node.state, "running");
    assert.equal(nodeState(fixture, fixtureIds.task), "running");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
  });

  it("a claim on a ready task opens an external objective run and an external task run", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const runs = runRows(fixture);
    assert.equal(runs.length, 2);
    const objectiveRun = runs.find((row) => row.kind === "objective");
    const taskRun = runs.find((row) => row.kind === "task");
    assert.ok(objectiveRun !== undefined);
    assert.ok(taskRun !== undefined);
    assert.equal(objectiveRun.node_id, fixtureIds.objective);
    assert.equal(objectiveRun.parent_run_id, null);
    assert.equal(taskRun.node_id, fixtureIds.task);
    assert.equal(taskRun.parent_run_id, objectiveRun.id);
    assert.equal(objectiveRun.driver, "external");
    assert.equal(taskRun.driver, "external");
    assert.equal(objectiveRun.workspace_id, null);
    assert.equal(objectiveRun.worker, null);
    assert.equal(objectiveRun.base_oid, null);
    assert.equal(taskRun.workspace_id, null);
    assert.equal(taskRun.worker, null);
    assert.equal(taskRun.base_oid, null);
    assert.equal(objectiveRun.lease_fence, 1);
    assert.equal(taskRun.lease_fence, 1);
    assert.equal(result.runId, taskRun.id);
    assert.equal(result.objectiveRunId, objectiveRun.id);
  });

  it("a claim on a ready task opens attempt number 1", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const attempts = attemptRows(fixture);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.run_id, result.runId);
    assert.equal(attempts[0]!.attempt_no, 1);
    assert.equal(attempts[0]!.outcome, null);
    assert.equal(result.attemptId, attempts[0]!.id);
    assert.equal(result.attemptNo, 1);
    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT driver FROM attempt WHERE id = ?", [
        result.attemptId,
      ]),
    ) as Readonly<{ driver: string }>;
    assert.equal(row.driver, "external");
  });

  it("a claim on an objective opens no attempt", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
    });
    assert.equal(result.attemptId, null);
    assert.equal(result.attemptNo, null);
    assert.equal(result.runId, result.objectiveRunId);
    const count = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS n FROM attempt"),
    ) as Readonly<{ n: number }>;
    assert.equal(count.n, 0);
    const runs = runRows(fixture);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.node_id, fixtureIds.objective);
    assert.equal(runs[0]!.kind, "objective");
  });

  it("heartbeatIntervalMs is one third of leaseTtlMs", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(result.heartbeatIntervalMs, 100000);
  });

  it("a claim on an initiative is refused initiative-not-claimable and writes nothing", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "initiative-not-claimable");
    assert.deepEqual(error.details, { refusal: "initiative-not-claimable" });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("an unknown node is refused node-not-found", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: "node_does_not_exist",
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "node-not-found");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim under an objective that holds no task is refused plan-incomplete with exactly objective-without-task", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedEmptyObjectiveGraph(transaction);
    });
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: EMPTY_OBJECTIVE,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "plan-incomplete");
    const details = error.details as Readonly<{
      findings: readonly Readonly<{ code: string; id: string | null }>[];
    }>;
    assert.equal(details.findings.length, 1);
    assert.equal(details.findings[0]!.code, "objective-without-task");
    assert.equal(details.findings[0]!.id, EMPTY_OBJECTIVE);
    assert.deepEqual(databaseBytes(fixture.storage), before);
    const complete = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: COMPLETE_OBJECTIVE,
      actorId: ACTOR_A,
    });
    assert.equal(complete.lease.subjectId, COMPLETE_OBJECTIVE);
    assert.equal(nodeState(fixture, COMPLETE_OBJECTIVE), "running");
  });

  it("a claim on the claimed node in any of six states is refused illegal-transition", (t) => {
    for (const state of SIX_STATES) {
      // awaiting_approval and partial are schema-forbidden on a task
      // (migration 0002's node CHECKs admit them on an objective only), so
      // those two iterations claim the objective in that state; the state
      // branch is kind-agnostic and refuses with the same details.
      const onObjective = state === "awaiting_approval" || state === "partial";
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        seedNodeState(transaction, fixtureIds.initiative, "ready");
        seedNodeState(
          transaction,
          onObjective ? fixtureIds.objective : fixtureIds.task,
          state,
        );
        seedNodeState(
          transaction,
          onObjective ? fixtureIds.task : fixtureIds.objective,
          "ready",
        );
      });
      const before = databaseBytes(fixture.storage);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: onObjective ? fixtureIds.objective : fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(error.refusal, "illegal-transition");
      assert.deepEqual(error.details, {
        state,
        admitted: ["ready", "running"],
      });
      assert.ok(!("ancestorId" in (error.details ?? {})));
      assert.deepEqual(databaseBytes(fixture.storage), before);
    }
  });

  it("a claim on a task whose objective is already running writes no objective state change and still succeeds", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "running");
      seedNodeState(transaction, fixtureIds.task, "ready");
    });
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(result.lease.owner, ACTOR_A);
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    const objectiveCalls = setNodeStateCalls(fixture).filter(
      (input) => input.id === fixtureIds.objective,
    );
    assert.equal(objectiveCalls.length, 0);
  });

  it("the state branch holds two cases only", (t) => {
    {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const result = claim(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(nodeState(fixture, fixtureIds.task), "running");
      const replay = claim(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(replay.runId, result.runId);
    }
    for (const state of SIX_STATES) {
      // Same schema constraint as the six-state loop above: the two
      // objective-only states claim the objective, the other four the task.
      const onObjective = state === "awaiting_approval" || state === "partial";
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        seedNodeState(transaction, fixtureIds.initiative, "ready");
        seedNodeState(
          transaction,
          onObjective ? fixtureIds.objective : fixtureIds.task,
          state,
        );
        seedNodeState(
          transaction,
          onObjective ? fixtureIds.task : fixtureIds.objective,
          "ready",
        );
      });
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: onObjective ? fixtureIds.objective : fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(error.refusal, "illegal-transition");
      assert.deepEqual(error.details, {
        state,
        admitted: ["ready", "running"],
      });
    }
  });

  it("a replayed claim writes nothing at all", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const first = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const before = databaseBytes(fixture.storage);
    const eventsBefore = fixture.events.list({}).length;
    const second = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(second.lease.fence, first.lease.fence);
    assert.equal(second.lease.expiresAt, first.lease.expiresAt);
    assert.equal(second.objectiveLease.fence, first.objectiveLease.fence);
    assert.equal(
      second.objectiveLease.expiresAt,
      first.objectiveLease.expiresAt,
    );
    assert.equal(second.runId, first.runId);
    assert.equal(second.objectiveRunId, first.objectiveRunId);
    assert.equal(second.attemptId, first.attemptId);
    assert.equal(second.attemptNo, first.attemptNo);
    const attempts = attemptRows(fixture);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.run_id, first.runId);
    assert.equal(fixture.events.list({}).length, eventsBefore);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a replayed claim opens no second attempt", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(fixture.execution.openAttemptCalls.length, 1);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(fixture.execution.openAttemptCalls.length, 1);
  });

  it("a new acquisition over a freed row is not mistaken for a replay", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.closeAttempt(transaction, {
        attemptId: first.attemptId!,
        outcome: "cancelled",
        at: NOW,
      });
      fixture.execution.execution.endRun(transaction, {
        runId: first.runId,
        outcome: "released",
        at: NOW,
      });
      fixture.execution.execution.endRun(transaction, {
        runId: first.objectiveRunId,
        outcome: "released",
        at: NOW,
      });
      fixture.lease.lease.release(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.task,
        owner: ACTOR_A,
        ownerKind: "actor",
        fence: first.lease.fence,
        now: NOW,
      });
      fixture.lease.lease.release(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.objective,
        owner: ACTOR_A,
        ownerKind: "actor",
        fence: first.objectiveLease.fence,
        now: NOW,
      });
      fixture.plan.plan.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "running",
        to: "ready",
        trigger: "claim-released",
        blockReason: null,
        at: NOW,
        cause: { revision: REVISION_A, importId: null },
      });
    });
    const eventsBefore = fixture.events.list({}).length;
    const second = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(second.lease.owner, ACTOR_B);
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.attemptNo, 1);
    const events = fixture.events.list({});
    assert.equal(events.length, eventsBefore + 2);
    assert.equal(events[events.length - 2]!.type, "lease.claimed");
    assert.equal(events[events.length - 2]!.actorId, ACTOR_B);
    assert.equal(events[events.length - 1]!.type, "node.running");
  });

  it("the same actor holds two ready sibling task claims concurrently", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const second = claim(fixture, clock, {
      nodeId: TASK_B,
      actorId: ACTOR_A,
    });
    assert.equal(second.objectiveLease.fence, first.objectiveLease.fence);
    assert.equal(second.objectiveLease.fence, 1);
    assert.equal(second.objectiveRunId, first.objectiveRunId);
    assert.notEqual(second.runId, first.runId);
    const leases = leaseRows(fixture);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(objectiveLease !== undefined);
    assert.equal(objectiveLease.fence, 1);
    assert.equal(objectiveLease.owner, ACTOR_A);
    const taskRuns = runRows(fixture).filter((row) => row.kind === "task");
    assert.equal(taskRuns.length, 2);
    assert.ok(
      taskRuns.every((row) => row.parent_run_id === first.objectiveRunId),
    );
  });

  it("an actor claims an objective and then a task under it with no self-deadlock", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const objectiveClaim = claim(fixture, clock, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
    });
    assert.equal(objectiveClaim.attemptId, null);
    const taskClaim = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(taskClaim.lease.owner, ACTOR_A);
    assert.equal(
      taskClaim.objectiveLease.fence,
      objectiveClaim.objectiveLease.fence,
    );
    assert.equal(taskClaim.objectiveRunId, objectiveClaim.objectiveRunId);
    const runs = runRows(fixture);
    assert.equal(runs.length, 2);
    assert.equal(runs.filter((row) => row.kind === "objective").length, 1);
  });

  it("a second actor's claim on a sibling task is refused lease-held with relation sibling", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    seedTaskLease(fixture);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: TASK_B,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    const details = error.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, fixtureIds.task);
    assert.equal(details.relation, "sibling");
    assert.equal(details.holder, ACTOR_A);
    assert.equal(details.holderKind, "actor");
    assert.equal(details.fence, 1);
    assert.equal(details.expiresAt, NOW + TTL);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a second actor's claim on the objective is refused lease-held with relation descendant", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    seedTaskLease(fixture);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    const details = error.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, fixtureIds.task);
    assert.equal(details.relation, "descendant");
    assert.equal(details.holder, ACTOR_A);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a second actor's claim on the same task is refused lease-held with relation self", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    seedTaskLease(fixture);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    const details = error.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, fixtureIds.task);
    assert.equal(details.relation, "self");
    assert.equal(details.holder, ACTOR_A);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim over an expired lease goes through the sweep and never through a takeover branch", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const mutable = createMutableClock();
    claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const now2 = NOW + TTL + 1;
    mutable.advance(TTL + 1);
    const second = claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(nodeState(fixture, fixtureIds.task), "running");
    assert.equal(second.lease.owner, ACTOR_B);
    assert.equal(second.lease.fence, 2);
    assert.equal(second.objectiveLease.fence, 2);
    assert.equal(second.attemptNo, 1);
    const runs = runRows(fixture);
    const objectiveRuns = runs.filter(
      (row) => row.node_id === fixtureIds.objective,
    );
    assert.equal(objectiveRuns.length, 2);
    const oldObjectiveRun = objectiveRuns.find(
      (row) => row.outcome === "expired",
    );
    const newObjectiveRun = objectiveRuns.find((row) => row.state === "active");
    assert.ok(oldObjectiveRun !== undefined);
    assert.ok(newObjectiveRun !== undefined);
    assert.equal(oldObjectiveRun.driver, "external");
    assert.equal(second.objectiveRunId, newObjectiveRun.id);
    const taskRuns = runs.filter((row) => row.node_id === fixtureIds.task);
    assert.equal(taskRuns.length, 2);
    const oldTaskRun = taskRuns.find((row) => row.outcome === "expired");
    const newTaskRun = taskRuns.find((row) => row.state === "active");
    assert.ok(oldTaskRun !== undefined);
    assert.ok(newTaskRun !== undefined);
    assert.equal(newTaskRun.parent_run_id, newObjectiveRun.id);
    assert.equal(second.runId, newTaskRun.id);
    const attempts = attemptRows(fixture);
    assert.equal(attempts.length, 2);
    const oldAttempt = attempts.find((row) => row.outcome === "cancelled");
    const newAttempt = attempts.find((row) => row.outcome === null);
    assert.ok(oldAttempt !== undefined);
    assert.ok(newAttempt !== undefined);
    assert.equal(oldAttempt.run_id, oldTaskRun.id);
    assert.equal(oldAttempt.attempt_no, 1);
    assert.equal(newAttempt.run_id, newTaskRun.id);
    assert.equal(newAttempt.attempt_no, 1);
    const leases = leaseRows(fixture);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    const taskLease = leases.find((row) => row.subject_id === fixtureIds.task);
    assert.ok(objectiveLease !== undefined);
    assert.ok(taskLease !== undefined);
    assert.equal(objectiveLease.owner, ACTOR_B);
    assert.equal(objectiveLease.fence, 2);
    assert.equal(taskLease.owner, ACTOR_B);
    assert.equal(taskLease.fence, 2);
    const events = lastEvents(fixture, 4);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "recovery.leaseRecovered",
        "recovery.leaseRecovered",
        "lease.claimed",
        "node.running",
      ],
    );
    assert.deepEqual(
      events.slice(0, 2).map((event) => event.subjectId),
      [fixtureIds.objective, fixtureIds.task],
    );
    assert.equal(events[3]!.subjectId, fixtureIds.task);
    const claimed = events[2]!;
    assert.equal(claimed.subjectId, fixtureIds.task);
    assert.equal(claimed.actorKind, "harness");
    assert.equal(claimed.actorId, ACTOR_B);
    const payload = claimed.payload as Readonly<Record<string, unknown>>;
    assert.equal(payload.subjectId, fixtureIds.task);
    assert.equal(payload.objectiveId, fixtureIds.objective);
    assert.equal(payload.fence, 2);
    assert.equal(payload.objectiveFence, 2);
    assert.equal(payload.expiresAt, now2 + TTL);
    assert.equal(payload.runId, second.runId);
    assert.equal(payload.objectiveRunId, second.objectiveRunId);
    assert.equal(payload.attemptId, second.attemptId);
    assert.equal(payload.attemptNo, 1);
  });

  it("a re-claim on the same run numbers the next attempt 2", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.closeAttempt(transaction, {
        attemptId: first.attemptId!,
        outcome: "cancelled",
        at: NOW,
      });
      fixture.execution.execution.endRun(transaction, {
        runId: first.runId,
        outcome: "released",
        at: NOW,
      });
      fixture.lease.lease.release(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.task,
        owner: ACTOR_A,
        ownerKind: "actor",
        fence: first.lease.fence,
        now: NOW,
      });
      fixture.plan.plan.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "running",
        to: "ready",
        trigger: "claim-released",
        blockReason: null,
        at: NOW,
        cause: { revision: REVISION_A, importId: null },
      });
    });
    const second = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.attemptNo, 1);
    const next = fixture.storage.transact((transaction) =>
      fixture.execution.execution.openAttempt(transaction, {
        runId: first.runId,
      }),
    );
    assert.equal(next.attemptNo, 2);
  });

  it("no event of type lease.takenOver exists in the repository", () => {
    const srcDir = fileURLToPath(new URL("../../", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(srcDir);
    const offenders: string[] = [];
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      if (file.endsWith(".test.ts")) continue;
      if (fs.readFileSync(file, "utf8").includes("lease.takenOver")) {
        offenders.push(file);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("the drive-mode pin refuses a harness claim on an objective whose history holds an internal run", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "ready");
      seedNodeState(transaction, fixtureIds.task, "ready");
      seedWorkspaceOnNode(transaction, {
        id: "workspace_a",
        nodeId: fixtureIds.objective,
      });
      seedRunRow(transaction, {
        id: "run_internal",
        kind: "objective",
        nodeId: fixtureIds.objective,
        parentRunId: null,
        workspaceId: "workspace_a",
        state: "ended",
      });
    });
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "drive-mode-pinned");
    assert.deepEqual(error.details, {
      pinnedDriver: "internal",
      claimDriver: "external",
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim over an active run of another driver is drive-mode-pinned and adopts nothing", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "ready");
      seedNodeState(transaction, fixtureIds.task, "ready");
      seedWorkspaceOnNode(transaction, {
        id: "workspace_a",
        nodeId: fixtureIds.objective,
      });
      seedRunRow(transaction, {
        id: "run_internal",
        kind: "objective",
        nodeId: fixtureIds.objective,
        parentRunId: null,
        workspaceId: "workspace_a",
      });
    });
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "drive-mode-pinned");
    assert.deepEqual(error.details, {
      pinnedDriver: "internal",
      claimDriver: "external",
    });
    assert.equal(fixture.execution.adoptRunCalls.length, 0);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a second claim after a rejected report adopts the same run", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    reportTaskOutcome(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      outcome: "rejected",
      fence: first.lease.fence,
    });
    const second = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(second.runId, first.runId);
    assert.equal(second.objectiveRunId, first.objectiveRunId);
    assert.equal(second.attemptNo, 2);
    assert.equal(second.lease.fence, first.lease.fence + 1);
    assert.equal(second.objectiveLease.fence, first.objectiveLease.fence);
    const attempts = attemptRows(fixture);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.run_id, first.runId);
    assert.equal(attempts[0]!.attempt_no, 1);
    assert.equal(attempts[0]!.outcome, "rejected");
    assert.equal(attempts[1]!.run_id, first.runId);
    assert.equal(attempts[1]!.attempt_no, 2);
    assert.equal(attempts[1]!.outcome, null);
  });

  it("a second claim after a cancelled report and after a failed report adopts the same run", (t) => {
    for (const outcome of ["cancelled", "failed"] as const) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      const first = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      reportTaskOutcome(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        outcome,
        fence: first.lease.fence,
      });
      const second = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(second.runId, first.runId, outcome);
      assert.equal(second.objectiveRunId, first.objectiveRunId, outcome);
      assert.equal(second.attemptNo, 2, outcome);
      assert.equal(second.lease.fence, first.lease.fence + 1, outcome);
      assert.equal(
        second.objectiveLease.fence,
        first.objectiveLease.fence,
        outcome,
      );
    }
  });

  it("a second actor cannot claim a task whose objective lease is held", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    reportTaskOutcome(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      outcome: "rejected",
      fence: first.lease.fence,
    });
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(error.details, {
      subject: fixtureIds.objective,
      holder: ACTOR_A,
      holderKind: "actor",
      fence: 1,
      expiresAt: NOW + TTL,
      relation: "ancestor",
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("the same actor claims a sibling task under the held objective lease", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    reportTaskOutcome(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      outcome: "rejected",
      fence: first.lease.fence,
    });
    const second = claim(fixture, clock, {
      nodeId: TASK_B,
      actorId: ACTOR_A,
    });
    assert.equal(second.objectiveRunId, first.objectiveRunId);
    assert.equal(second.objectiveLease.fence, first.objectiveLease.fence);
    const objectiveRuns = runRows(fixture).filter(
      (row) => row.node_id === fixtureIds.objective,
    );
    assert.equal(objectiveRuns.length, 1);
    const siblingRun = runRows(fixture).find((row) => row.node_id === TASK_B);
    assert.ok(siblingRun !== undefined);
    assert.equal(siblingRun.parent_run_id, first.objectiveRunId);
  });

  it("the active run survives a restart and adoption is the only recovery", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    reportTaskOutcome(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      outcome: "rejected",
      fence: first.lease.fence,
    });
    // The restart itself is covered end to end in Story 20. This is the
    // unit-level part: with the run active and the task lease free, a claim
    // adopts rather than opens, proved by the run row count staying at one.
    const taskRunsBefore = runRows(fixture).filter(
      (row) => row.node_id === fixtureIds.task,
    );
    assert.equal(taskRunsBefore.length, 1);
    const second = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const taskRunsAfter = runRows(fixture).filter(
      (row) => row.node_id === fixtureIds.task,
    );
    assert.equal(taskRunsAfter.length, 1);
    assert.equal(second.runId, first.runId);
  });

  it("a claim whose run history is empty succeeds, and a claim whose history holds external runs only succeeds", (t) => {
    {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const result = claim(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(result.lease.owner, ACTOR_A);
    }
    {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      fixture.storage.transact((transaction) => {
        const run = fixture.execution.execution.openRun(transaction, {
          kind: "objective",
          nodeId: fixtureIds.objective,
          parentRunId: null,
          leaseFence: 1,
          attemptLimit: ATTEMPT_LIMIT,
        });
        fixture.execution.execution.endRun(transaction, {
          runId: run.id,
          outcome: "expired",
          at: NOW,
        });
      });
      const result = claim(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(result.lease.owner, ACTOR_A);
      assert.equal(result.attemptNo, 1);
    }
  });

  it("the claimed task write names trigger claim-taken", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const calls = setNodeStateCalls(fixture);
    const triggers = [...new Set(calls.map((input) => input.trigger))].sort();
    assert.deepEqual(triggers, ["ancestor-started", "claim-taken"]);
    const taskCalls = calls.filter((input) => input.id === fixtureIds.task);
    assert.equal(taskCalls.length, 1);
    assert.equal(taskCalls[0]!.trigger, "claim-taken");
    assert.equal(taskCalls[0]!.from, "ready");
    assert.equal(taskCalls[0]!.to, "running");
  });

  it("a setNodeState call whose trigger disagrees with the pair throws and commits nothing", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "running",
            to: "ready",
            trigger: "claim-taken",
            blockReason: null,
            at: NOW,
            cause: { revision: REVISION_A, importId: null },
          });
        }),
      /claim-taken declares ready -> running/,
    );
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("no path of the claim writes awaiting_approval", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const states = fixture.storage.transact((transaction) =>
      transaction.all("SELECT state FROM node"),
    ) as readonly Readonly<{ state: string }>[];
    assert.ok(
      states.every((row) => row.state !== "awaiting_approval"),
      `unexpected awaiting_approval in ${JSON.stringify(states)}`,
    );
  });

  it("the sibling race commits exactly one claim", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(first.lease.owner, ACTOR_A);
    const error = refused(fixture, clock, {
      nodeId: TASK_B,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "lease-held");
    const leases = leaseRows(fixture);
    const held = leases.filter((row) => row.owner !== null);
    assert.equal(held.length, 2);
    const openAttempts = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT COUNT(*) AS n FROM attempt WHERE outcome IS NULL",
      ),
    ) as Readonly<{ n: number }>;
    assert.equal(openAttempts.n, 1);
  });

  it("one claim reads the clock once", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const mutable = createMutableClock();
    claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(mutable.calls(), 1);
  });

  it("the abandoned objective is freed by expiry and by nothing else", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedSecondProjectFixture(fixture);
    const mutable = createMutableClock();
    claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    mutable.advance(TTL + 1);
    claim(fixture, mutable.clock, {
      nodeId: "task_pb",
      actorId: ACTOR_B,
    });
    const leases = leaseRows(fixture);
    const objectiveLease = leases.find(
      (row) => row.subject_id === fixtureIds.objective,
    );
    assert.ok(objectiveLease !== undefined);
    assert.equal(objectiveLease.owner, null);
    const objectiveRuns = runRows(fixture).filter(
      (row) => row.node_id === fixtureIds.objective,
    );
    assert.equal(objectiveRuns.length, 1);
    assert.equal(objectiveRuns[0]!.state, "ended");
    assert.equal(objectiveRuns[0]!.outcome, "expired");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
    const taskClaim = claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(taskClaim.lease.owner, ACTOR_B);
    const objectiveClaim = claim(fixture, mutable.clock, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_B,
    });
    assert.equal(objectiveClaim.objectiveLease.owner, ACTOR_B);
  });

  it("the claim-driven sweep needs no restart and no timer", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedSecondProjectFixture(fixture);
    const mutable = createMutableClock();
    claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    mutable.advance(TTL + 1);
    claim(fixture, mutable.clock, {
      nodeId: "task_pb",
      actorId: ACTOR_B,
    });
    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
    const taskRuns = runRows(fixture).filter(
      (row) => row.node_id === fixtureIds.task,
    );
    assert.equal(taskRuns.length, 1);
    assert.equal(taskRuns[0]!.state, "ended");
    assert.equal(taskRuns[0]!.outcome, "expired");
    const attempts = attemptRows(fixture).filter(
      (row) => row.run_id === taskRuns[0]!.id,
    );
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.outcome, "cancelled");
    const taskLease = leaseRows(fixture).find(
      (row) => row.subject_id === fixtureIds.task,
    );
    assert.ok(taskLease !== undefined);
    assert.equal(taskLease.owner, null);
    assert.equal(taskLease.fence, 1);
    const re = claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(re.lease.owner, ACTOR_B);
    assert.equal(re.lease.fence, 2);
  });

  it("a task claim starts the objective and then the initiative", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
    assert.deepEqual(
      runningEvents(fixture).map((event) => event.subjectId),
      [fixtureIds.objective, fixtureIds.initiative, fixtureIds.task],
    );
  });

  it("an objective claim starts the initiative only", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
    });
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
    assert.deepEqual(
      runningEvents(fixture).map((event) => event.subjectId),
      [fixtureIds.initiative, fixtureIds.objective],
    );
    assert.equal(result.runId, result.objectiveRunId);
  });

  it("each cascade write records trigger ancestor-started", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const calls = setNodeStateCalls(fixture);
    const cascadeCalls = calls.filter((input) => input.id !== fixtureIds.task);
    assert.equal(cascadeCalls.length, 2);
    assert.deepEqual(
      cascadeCalls.map((input) => input.id),
      [fixtureIds.objective, fixtureIds.initiative],
    );
    assert.ok(
      cascadeCalls.every((input) => input.trigger === "ancestor-started"),
    );
  });

  it("each cascade event is attributed to the daemon with reason child-started", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const cascadeEvents = runningEvents(fixture).filter(
      (event) => event.subjectId !== fixtureIds.task,
    );
    assert.equal(cascadeEvents.length, 2);
    for (const event of cascadeEvents) {
      assert.equal(event.actorKind, "daemon");
      assert.equal(event.actorId, INSTANCE);
      assert.equal(
        (event.payload as Readonly<{ reason?: unknown }>).reason,
        "child-started",
      );
    }
  });

  it("the claimed node's own event keeps the calling actor", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      actorKind: "harness",
    });
    const taskEvent = runningEvents(fixture).find(
      (event) => event.subjectId === fixtureIds.task,
    );
    assert.ok(taskEvent !== undefined);
    assert.equal(taskEvent.actorKind, "harness");
    assert.equal(taskEvent.actorId, ACTOR_A);
  });

  it("an ancestor already running is left untouched", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "running");
      seedNodeState(transaction, fixtureIds.task, "ready");
    });
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const objectiveCalls = setNodeStateCalls(fixture).filter(
      (input) => input.id === fixtureIds.objective,
    );
    assert.equal(objectiveCalls.length, 0);
    const objectiveEvents = runningEvents(fixture).filter(
      (event) => event.subjectId === fixtureIds.objective,
    );
    assert.equal(objectiveEvents.length, 0);
  });

  it("an ancestor in any of six other states refuses the whole claim", (t) => {
    for (const state of SIX_STATES) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        // A discarded ancestor is excluded from the completeness children
        // (Story 10), so with the objective as the initiative's only child
        // the completeness check fires plan-incomplete before the cascade.
        // A second live objective keeps the initiative complete, so the
        // discarded objective is reached as the claimed task's ancestor.
        if (state === "discarded") {
          seedSiblingObjective(transaction);
        }
        seedNodeState(transaction, fixtureIds.initiative, "ready");
        seedNodeState(transaction, fixtureIds.objective, state);
        seedNodeState(transaction, fixtureIds.task, "ready");
      });
      const before = databaseBytes(fixture.storage);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(error.refusal, "ancestor-not-startable");
      assert.deepEqual(error.details, {
        ancestorId: fixtureIds.objective,
        state,
        admitted: ["ready", "running"],
      });
      assert.deepEqual(databaseBytes(fixture.storage), before);
    }
  });

  it("a refused cascade writes no partial cascade", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "done");
      seedNodeState(transaction, fixtureIds.objective, "ready");
      seedNodeState(transaction, fixtureIds.task, "ready");
    });
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "ancestor-not-startable");
    assert.equal(nodeState(fixture, fixtureIds.objective), "ready");
    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
  });

  it("a cascade with the ancestor-started trigger on a task node throws", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "ready",
            to: "running",
            trigger: "ancestor-started",
            blockReason: null,
            at: NOW,
            cause: { revision: REVISION_A, importId: null },
          });
        }),
      /declares levels/,
    );
  });

  it("the full event order of one claim is exact", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSecondRevisionWithTask(transaction);
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "ready");
      seedNodeState(transaction, fixtureIds.task, "ready");
      seedNodeState(transaction, TASK_B, "running");
      const objectiveRun = fixture.execution.execution.openRun(transaction, {
        kind: "objective",
        nodeId: fixtureIds.objective,
        parentRunId: null,
        leaseFence: 1,
        attemptLimit: ATTEMPT_LIMIT,
      });
      const taskRun = fixture.execution.execution.openRun(transaction, {
        kind: "task",
        nodeId: TASK_B,
        parentRunId: objectiveRun.id,
        leaseFence: 1,
        attemptLimit: ATTEMPT_LIMIT,
      });
      fixture.execution.execution.openAttempt(transaction, {
        runId: taskRun.id,
      });
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'actor', 1, ?, ?, ?)",
        [TASK_B, ACTOR_B, NOW - 100, NOW - 100, NOW - 1],
      );
    });
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const events = lastEvents(fixture, 5);
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "recovery.leaseRecovered",
        "lease.claimed",
        "node.running",
        "node.running",
        "node.running",
      ],
    );
    assert.deepEqual(
      events.slice(2).map((event) => event.subjectId),
      [fixtureIds.objective, fixtureIds.initiative, fixtureIds.task],
    );
  });
});
