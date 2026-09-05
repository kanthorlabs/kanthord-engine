import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { externalTransitions } from "../../domain/external-transition.ts";
import type { RunRecord } from "../../services/execution/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { expireRuns } from "../run/expire-runs.ts";
import { sweepExpiredExternalLeases } from "../startup/recover-expired-leases.ts";
import {
  claimNode,
  ClaimNodeError,
  type ClaimNodeResult,
} from "./claim-node.ts";
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
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";
import { workerRegistry } from "../../domain/worker-registry.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
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
      expiry: {
        expireRuns(transaction: Transaction, input: Readonly<{ now: number }>) {
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
      callerRecord: { worker: "claude@1", authorized: ["claude@1"] },
      registry: workerRegistry,
      attemptLimit: ATTEMPT_LIMIT,
      leaseTtlMs: TTL,
      runTtlMs: 120000,
      runMaxLifetimeMs: 900000,
      instanceId: INSTANCE,
    },
    {
      nodeId,
      actorId,
      actorKind: "harness",
      available: true,
    },
  );
}

function release(
  fixture: ReleaseFixture,
  clock: Clock,
  input: Readonly<{
    nodeId: string;
    fence: number;
    runId: string;
    runFence: number;
    actorId: string;
    caller?: string;
    expiryPass?: boolean;
  }>,
): ReleaseNodeResult {
  const releaseInput = {
    nodeId: input.nodeId,
    fence: input.fence,
    runId: input.runId,
    runFence: input.runFence,
    actorId: input.actorId,
    actorKind: "harness" as const,
  };
  return releaseNode(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
      expiry: {
        expireRuns(
          transaction: Transaction,
          expiryInput: Readonly<{ now: number }>,
        ) {
          if (input.expiryPass === false) {
            return [];
          }
          return expireRuns(
            {
              events: fixture.events,
              execution: fixture.execution.execution,
              instanceId: INSTANCE,
            },
            transaction,
            expiryInput,
          );
        },
      },
      caller: input.caller ?? "claude@1",
    },
    releaseInput,
  );
}

function refused(
  fixture: ReleaseFixture,
  clock: Clock,
  input: Readonly<{
    nodeId: string;
    fence: number;
    runId: string;
    runFence: number;
    actorId: string;
    caller?: string;
    expiryPass?: boolean;
  }>,
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

function openObjectiveRun(fixture: ReleaseFixture): RunRecord {
  return fixture.storage.transact((transaction) =>
    fixture.execution.execution.openRun(transaction, {
      nodeId: fixtureIds.objective,
      kind: "structural",
      workspaceId: null,
      worker: "claude@1",
      fence: 1,
      attemptLimit: ATTEMPT_LIMIT,
      judgedOid: null,
      graphRevision: null,
      agents: [],
      expiresAt: NOW + TTL,
      maxLifetimeAt: NOW + 900000,
    }),
  );
}

function openTaskRun(fixture: ReleaseFixture, nodeId: string): RunRecord {
  return fixture.storage.transact((transaction) => {
    const run = fixture.execution.execution.openRun(transaction, {
      nodeId,
      kind: "execution",
      workspaceId: null,
      worker: "claude@1",
      fence: 1,
      attemptLimit: ATTEMPT_LIMIT,
      judgedOid: null,
      graphRevision: fixtureIds.planRevision,
      agents: [],
      expiresAt: NOW + TTL,
      maxLifetimeAt: NOW + 900000,
    });
    fixture.execution.execution.openAttempt(transaction, { runId: run.id });
    return run;
  });
}

function nodeState(fixture: ReleaseFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function nodeBlockReason(fixture: ReleaseFixture, id: string): string | null {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT block_reason FROM node WHERE id = ?", [
      id,
    ]) as Readonly<{ block_reason: string | null }> | undefined;
    return row?.block_reason ?? null;
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
  fence: number;
  state: string;
  outcome: string | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      `SELECT id, kind, node_id, fence, state, outcome
FROM run
ORDER BY id`,
    ),
  ) as readonly Readonly<{
    id: string;
    kind: string;
    node_id: string;
    fence: number;
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
  it("a release ends the run and raises the fence", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    const run = runRows(fixture).find((row) => row.id === claimed.runId);
    assert.ok(run !== undefined);
    assert.equal(run.state, "ended");
    assert.equal(run.fence, 2);
  });

  it("a release returns the node to ready and closes the open attempt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    assert.ok(claimed.attemptId !== null);

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(nodeState(fixture, fixtureIds.task), "ready");
    const attempt = attemptRows(fixture).find(
      (row) => row.id === claimed.attemptId,
    );
    assert.ok(attempt !== undefined);
    assert.equal(attempt.outcome, "cancelled");
    const run = runRows(fixture).find((row) => row.id === claimed.runId);
    assert.ok(run !== undefined);
    assert.equal(run.state, "ended");
  });

  it("a release reads the attempts once", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const readsBefore = fixture.execution.attemptsOfRunCalls.length;

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(fixture.execution.attemptsOfRunCalls.length - readsBefore, 1);
  });

  it("a release appends exactly one run.ended event with outcome released and no lease.released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    const subjectEvents = fixture.events.list({
      subjectKind: "run",
      subject: claimed.runId,
    });
    const endedEvents = subjectEvents.filter(
      (event) => event.type === "run.ended",
    );
    assert.equal(endedEvents.length, 1);
    const endedEvent = endedEvents[0];
    assert.ok(endedEvent !== undefined);
    assert.equal(endedEvent.type, "run.ended");
    assert.equal(endedEvent.subjectKind, "run");
    assert.equal(endedEvent.subjectId, claimed.runId);
    const payload = endedEvent.payload as Readonly<Record<string, unknown>>;
    assert.equal(payload.runId, claimed.runId);
    assert.equal(payload.outcome, "released");
    assert.equal(payload.reason, null);
    assert.equal(
      fixture.events.list({ subjectKind: "node", type: "run.ended" }).length,
      0,
    );
    assert.equal(
      subjectEvents.some((event) => event.type === "lease.released"),
      false,
    );
  });

  it("exactly one terminal event is appended per ended run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    const terminalEvents = fixture.events
      .list({ subject: claimed.runId })
      .filter((event) => {
        if (event.type !== "run.ended" && event.type !== "run.expired") {
          return false;
        }
        const payload = event.payload as Readonly<{ runId?: string }>;
        return payload.runId === claimed.runId;
      });

    assert.equal(terminalEvents.length, 1);
    assert.equal(terminalEvents[0]?.type, "run.ended");
  });

  it("node.assignment is unchanged after a release", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const assignmentBefore = fixture.storage.transact((transaction) => {
      const row = transaction.get("SELECT assignment FROM node WHERE id = ?", [
        fixtureIds.task,
      ]) as Readonly<{ assignment: string | null }> | undefined;
      assert.ok(row !== undefined);
      return row.assignment;
    });
    assert.equal(assignmentBefore, "claude@1");

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    const assignmentAfter = fixture.storage.transact((transaction) => {
      const row = transaction.get("SELECT assignment FROM node WHERE id = ?", [
        fixtureIds.task,
      ]) as Readonly<{ assignment: string | null }> | undefined;
      assert.ok(row !== undefined);
      return row.assignment;
    });
    assert.equal(assignmentAfter, assignmentBefore);
  });

  it("a release refuses a stale fence", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    fixture.storage.transact((transaction) => {
      transaction.run("UPDATE run SET fence = 2 WHERE id = ?", [claimed.runId]);
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: 1,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "fence-stale");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a release refuses an ended run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "UPDATE run SET state = 'ended', ended_at = ? WHERE id = ?",
        [NOW, claimed.runId],
      );
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "run-ended");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a release on an expired run refuses and writes nothing", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    fixture.storage.transact((transaction) => {
      transaction.run("UPDATE run SET expires_at = ? WHERE id = ?", [
        NOW - 1,
        claimed.runId,
      ]);
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "run-ended");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a release on an unknown node refuses node-not-found, not target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: "task_zzz",
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "node-not-found");
    assert.notEqual(error.refusal, "target-outside-run");
  });

  it("a release on an initiative refuses initiative-not-claimable, not target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "initiative-not-claimable");
    assert.notEqual(error.refusal, "target-outside-run");
  });

  it("a release refuses a target outside the run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    fixture.storage.transact((transaction) => {
      seedSiblingTask(transaction);
      seedNodeState(transaction, "task_b", "running");
    });

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: "task_b",
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "target-outside-run");
  });

  it("a release on a task presenting the objective run refuses target-outside-run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.objectiveRunId,
      runFence: claimed.objectiveRunFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "target-outside-run");
  });

  it("a release refusal carries only the run id", (t) => {
    type AuthorityRefusal =
      | "run-not-found"
      | "run-ended"
      | "run-expired"
      | "run-caller-mismatch"
      | "target-outside-run"
      | "fence-stale";

    const scenarios: readonly Readonly<{
      refusal: AuthorityRefusal;
      prepare(
        fixture: ReleaseFixture,
        claimed: ClaimNodeResult,
      ): Readonly<{
        nodeId: string;
        runId: string;
        runFence: number;
        caller?: string;
        expiryPass?: boolean;
      }>;
    }>[] = [
      {
        refusal: "run-not-found",
        prepare(_fixture, claimed) {
          return {
            nodeId: fixtureIds.task,
            runId: "run_missing",
            runFence: claimed.runFence,
          };
        },
      },
      {
        refusal: "run-ended",
        prepare(fixture, claimed) {
          fixture.storage.transact((transaction) => {
            transaction.run(
              "UPDATE run SET state = 'ended', ended_at = ? WHERE id = ?",
              [NOW, claimed.runId],
            );
          });
          return {
            nodeId: fixtureIds.task,
            runId: claimed.runId,
            runFence: claimed.runFence,
          };
        },
      },
      {
        refusal: "run-expired",
        prepare(fixture, claimed) {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE run SET expires_at = ? WHERE id = ?", [
              NOW - 1,
              claimed.runId,
            ]);
          });
          return {
            nodeId: fixtureIds.task,
            runId: claimed.runId,
            runFence: claimed.runFence,
            expiryPass: false,
          };
        },
      },
      {
        refusal: "run-caller-mismatch",
        prepare(_fixture, claimed) {
          return {
            nodeId: fixtureIds.task,
            runId: claimed.runId,
            runFence: claimed.runFence,
            caller: "opencode@1",
          };
        },
      },
      {
        refusal: "target-outside-run",
        prepare(fixture, claimed) {
          fixture.storage.transact((transaction) => {
            seedSiblingTask(transaction);
            seedNodeState(transaction, "task_b", "running");
          });
          return {
            nodeId: "task_b",
            runId: claimed.runId,
            runFence: claimed.runFence,
          };
        },
      },
      {
        refusal: "fence-stale",
        prepare(fixture, claimed) {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE run SET fence = ? WHERE id = ?", [
              claimed.runFence + 1,
              claimed.runId,
            ]);
          });
          return {
            nodeId: fixtureIds.task,
            runId: claimed.runId,
            runFence: claimed.runFence,
          };
        },
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createFixture();
      t.after(() => fixture.dispose());
      seedReadyGraph(fixture);
      const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
      const scenarioInput = scenario.prepare(fixture, claimed);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: scenarioInput.nodeId,
        fence: claimed.lease.fence,
        runId: scenarioInput.runId,
        runFence: scenarioInput.runFence,
        actorId: ACTOR_A,
        caller: scenarioInput.caller,
        expiryPass: scenarioInput.expiryPass,
      });

      assert.equal(error.refusal, scenario.refusal);
      assert.deepEqual(Object.keys(error.details!), ["runId"]);
      assert.equal(error.details?.runId, scenarioInput.runId);
    }
  });

  it("the exhausted branch still blocks with attempt-limit and ends the run blocked", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    assert.ok(claimed.attemptId !== null);

    const secondAttempt = fixture.storage.transact((transaction) => {
      fixture.execution.execution.closeAttempt(transaction, {
        attemptId: claimed.attemptId!,
        outcome: "accepted",
        at: NOW,
      });
      return fixture.execution.execution.openAttempt(transaction, {
        runId: claimed.runId,
      });
    });
    const thirdAttempt = fixture.storage.transact((transaction) => {
      fixture.execution.execution.closeAttempt(transaction, {
        attemptId: secondAttempt.id,
        outcome: "accepted",
        at: NOW,
      });
      return fixture.execution.execution.openAttempt(transaction, {
        runId: claimed.runId,
      });
    });
    assert.equal(thirdAttempt.attemptNo, 3);

    const result = release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(result.node.state, "blocked");
    assert.equal(nodeState(fixture, fixtureIds.task), "blocked");
    assert.equal(nodeBlockReason(fixture, fixtureIds.task), "attempt-limit");

    const run = runRows(fixture).find((row) => row.id === claimed.runId);
    assert.ok(run !== undefined);
    assert.equal(run.state, "ended");
    assert.equal(run.outcome, "blocked");

    const endedEvents = fixture.events
      .list({ subjectKind: "run", subject: claimed.runId })
      .filter((event) => {
        if (event.type !== "run.ended") return false;
        const payload = event.payload as Readonly<{ runId?: string }>;
        return payload.runId === claimed.runId;
      });
    assert.equal(endedEvents.length, 1);
    const endedEvent = endedEvents[0];
    assert.ok(endedEvent !== undefined);
    assert.equal(endedEvent.subjectKind, "run");
    assert.equal(endedEvent.subjectId, claimed.runId);
    const payload = endedEvent.payload as Readonly<{
      runId?: string;
      outcome?: string;
    }>;
    assert.equal(payload.runId, claimed.runId);
    assert.equal(payload.outcome, "blocked");
    assert.equal(
      fixture.events.list({ subjectKind: "node", type: "run.ended" }).length,
      0,
    );
  });

  it("an objective release appends run.ended and no lease.released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const objectiveRun = openObjectiveRun(fixture);
    const objectiveLease = fixture.storage.transact((transaction) =>
      fixture.lease.lease.acquire(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.objective,
        owner: ACTOR_A,
        ownerKind: "actor",
        ttlMs: TTL,
        now: NOW,
      }),
    );

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: objectiveLease.record.fence,
      runId: objectiveRun.id,
      runFence: objectiveRun.fence,
      actorId: ACTOR_A,
    });

    const subjectEvents = fixture.events.list({
      subjectKind: "run",
      subject: objectiveRun.id,
    });
    const endedEvents = subjectEvents.filter(
      (event) => event.type === "run.ended",
    );
    assert.equal(endedEvents.length, 1);
    const endedEvent = endedEvents[0];
    assert.ok(endedEvent !== undefined);
    assert.equal(endedEvent.subjectKind, "run");
    assert.equal(endedEvent.subjectId, objectiveRun.id);
    const payload = endedEvent.payload as Readonly<{ runId?: string }>;
    assert.equal(payload.runId, objectiveRun.id);
    assert.equal(
      subjectEvents.some((event) => event.type === "lease.released"),
      false,
    );
    assert.equal(
      fixture.events.list({ subjectKind: "node", type: "run.ended" }).length,
      0,
    );
  });

  it("an objective release appends one run.ended event for every ended run", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    fixture.storage.transact((transaction) => {
      seedSiblingTask(transaction);
      seedNodeState(transaction, fixtureIds.task, "running");
      seedNodeState(transaction, "task_b", "running");
    });
    const objectiveRun = openObjectiveRun(fixture);
    const taskRun = openTaskRun(fixture, fixtureIds.task);
    const siblingRun = openTaskRun(fixture, "task_b");
    const objectiveLease = fixture.storage.transact((transaction) =>
      fixture.lease.lease.acquire(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.objective,
        owner: ACTOR_A,
        ownerKind: "actor",
        ttlMs: TTL,
        now: NOW,
      }),
    );

    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: objectiveLease.record.fence,
      runId: objectiveRun.id,
      runFence: objectiveRun.fence,
      actorId: ACTOR_A,
    });

    const expectedEndedRunIds = [objectiveRun.id, taskRun.id, siblingRun.id];
    const endedRuns = runRows(fixture).filter((row) => row.state === "ended");
    assert.equal(endedRuns.length, 3);
    assert.deepEqual(
      new Set(endedRuns.map((run) => run.id)),
      new Set(expectedEndedRunIds),
    );
    for (const runId of expectedEndedRunIds) {
      const terminalEvents = fixture.events
        .list({ subjectKind: "run", subject: runId })
        .filter(
          (event) => event.type === "run.ended" || event.type === "run.expired",
        );
      assert.equal(terminalEvents.length, 1);
      const event = terminalEvents[0];
      assert.ok(event !== undefined);
      assert.equal(event.subjectKind, "run");
      assert.equal(event.subjectId, runId);
      const payload = event.payload as Readonly<{ runId?: string }>;
      assert.equal(event.subjectId, payload.runId);
    }
    assert.equal(
      fixture.events.list({ subjectKind: "node", type: "run.ended" }).length,
      0,
    );
  });

  it("a task release with the current fence frees the task lease, moves the task to ready, and leaves the fence unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const result = release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
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

  it("a task release records trigger claim-released", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const callsBefore = setNodeStateCalls(fixture).length;
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
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

  it("a task release with a stale run fence or a mismatched caller is refused and writes nothing", (t) => {
    for (const scenario of ["fence", "caller"] as const) {
      const fixture = createFixture();
      t.after(() => fixture.dispose());
      seedReadyGraph(fixture);
      const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
      const before = databaseBytes(fixture.storage);
      const eventsBefore = fixture.events.list({}).length;
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        fence: claimed.lease.fence,
        runId: claimed.runId,
        runFence:
          scenario === "fence" ? claimed.runFence - 1 : claimed.runFence,
        actorId: ACTOR_A,
        caller: scenario === "caller" ? "opencode@1" : undefined,
      });
      assert.equal(
        error.refusal,
        scenario === "fence" ? "fence-stale" : "run-caller-mismatch",
      );
      assert.deepEqual(error.details, { runId: claimed.runId });
      assert.deepEqual(databaseBytes(fixture.storage), before);
      assert.equal(fixture.events.list({}).length, eventsBefore);
    }
  });

  it("a release with valid run authority and a stale retained node-lease fence returns ReleaseNodeError lease-held, not LeaseError, and leaves databaseBytes unchanged", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    fixture.storage.transact((transaction) => {
      fixture.lease.lease.expireLeasesOfOwner(transaction, {
        owner: ACTOR_A,
        now: NOW,
      });
      const reclaimed = fixture.lease.lease.acquire(transaction, {
        subjectKind: "node",
        subjectId: fixtureIds.task,
        owner: ACTOR_A,
        ownerKind: "actor",
        ttlMs: TTL,
        now: NOW,
      });
      assert.equal(reclaimed.acquired, true);
      assert.equal(reclaimed.record.fence, claimed.lease.fence + 1);
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "lease-held");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("an objective release still refuses lease-held while a child lease is live", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const objectiveRun = runRows(fixture).find(
      (run) => run.id === claimed.objectiveRunId,
    );
    assert.ok(objectiveRun !== undefined);
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      fence: claimed.objectiveLease.fence,
      runId: objectiveRun.id,
      runFence: objectiveRun.fence,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "lease-held");
    const details = error.details as Readonly<Record<string, unknown>>;
    assert.equal(details.subject, fixtureIds.task);
    assert.equal(details.holder, ACTOR_A);
    assert.equal(details.relation, "descendant");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a stale release is refused run-ended and not no-open-attempt", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });
    const terminalEventsBefore = fixture.events
      .list({ type: "run.ended" })
      .filter((event) => {
        const payload = event.payload as Readonly<{ runId?: string }>;
        return payload.runId === claimed.runId;
      });
    assert.equal(terminalEventsBefore.length, 1);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "run-ended");
    assert.deepEqual(error.details, { runId: claimed.runId });
    assert.notEqual(error.refusal, "no-open-attempt");
    assert.notEqual(error.refusal, "run-not-active");
    const terminalEventsAfter = fixture.events
      .list({ type: "run.ended" })
      .filter((event) => {
        const payload = event.payload as Readonly<{ runId?: string }>;
        return payload.runId === claimed.runId;
      });
    assert.equal(terminalEventsAfter.length, terminalEventsBefore.length);
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
    const before = databaseBytes(fixture.storage);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "no-open-attempt");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a release result carries the node view", (t) => {
    const fixture = createFixture();
    t.after(() => fixture.dispose());
    seedReadyGraph(fixture);
    const claimed = claim(fixture, createMockClock({ start: NOW }), ACTOR_A);
    const result = release(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      fence: claimed.lease.fence,
      runId: claimed.runId,
      runFence: claimed.runFence,
      actorId: ACTOR_A,
    });
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(result.node.state, "ready");
  });
});
