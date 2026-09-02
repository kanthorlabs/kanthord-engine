import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Clock } from "../../services/clock/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { expireRuns } from "../run/expire-runs.ts";
import { claimNode, type ClaimNodeResult } from "../node/claim-node.ts";
import { releaseNode } from "../node/release-node.ts";
import type { NodeReportResult } from "../../domain/outcome-report.ts";
import {
  reportOutcome,
  ReportOutcomeError,
  type ReportOutcomeDependencies,
  type ReportOutcomeResult,
} from "./report-outcome.ts";
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
  probeNodeTitle,
  seedEdge,
  seedGraph,
  seedNodeState,
  seedRegistry,
  seedSecondRevisionWithTask,
} from "../../../test/helpers/rows.ts";
import { workerRegistry } from "../../domain/worker-registry.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
const ACTOR_B = "actor_beta";
const ATTEMPT_LIMIT = 3;
const TASK_B = "task_b";
const OBJECT_ID = "a".repeat(40);
const REASON = "base\nnot-é-漢字";
const NON_RUNNING_STATES = [
  "pending",
  "ready",
  "blocked",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;

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

type DelegatedReportObjective = ReportOutcomeDependencies["reportObjective"];
type DelegatedCloseObjective = ReportOutcomeDependencies["closeObjective"];
type ReportObjectiveInput = Parameters<DelegatedReportObjective>[1];
type CloseObjectiveInput = Parameters<DelegatedCloseObjective>[1];
type ReportBody = Parameters<typeof reportOutcome>[1]["body"];

type ObjectiveCall = Readonly<{
  transaction: Transaction;
  input: ReportObjectiveInput;
}>;
type CloseCall = Readonly<{
  transaction: Transaction;
  input: CloseObjectiveInput;
}>;
type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function cannedObjectiveResult(input: ReportObjectiveInput): NodeReportResult {
  return {
    nodeId: input.nodeId,
    kind: "objective",
    state: "awaiting_approval",
    blockReason: null,
    attemptId: null,
    attemptNo: null,
    attemptsRemaining: null,
    objectId: input.objectId,
    objectiveState: "awaiting_approval",
    objectiveProjection: "done",
  };
}

function cannedCloseResult(input: CloseObjectiveInput): NodeReportResult {
  return {
    nodeId: input.nodeId,
    kind: "objective",
    state: "done",
    blockReason: null,
    attemptId: null,
    attemptNo: null,
    attemptsRemaining: null,
    objectId: OBJECT_ID,
    objectiveState: "done",
    objectiveProjection: "done",
  };
}

function createRecordingEvents(): Readonly<{
  events: EventLog;
  appends: readonly RecordedAppend[];
}> {
  const appends: RecordedAppend[] = [];
  return {
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        appends.push({ transaction, input });
        return {
          id: `event_${appends.length}`,
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          payload: input.payload,
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return appends.map((record, index) => ({
          id: `event_${index + 1}`,
          subjectKind: record.input.subjectKind,
          subjectId: record.input.subjectId,
          type: record.input.type,
          actorKind: record.input.actorKind,
          actorId: record.input.actorId,
          payload: record.input.payload,
          occurredAt: 0,
        }));
      },
    },
    appends,
  };
}

type ReportFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  appends: readonly RecordedAppend[];
  reportObjective: DelegatedReportObjective;
  closeObjective: DelegatedCloseObjective;
  objectiveCalls: readonly ObjectiveCall[];
  closeCalls: readonly CloseCall[];
  dispose(): void;
}>;

function createReportFixture(): ReportFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const recorder = createRecordingEvents();
  const execution = createBackedExecutionFake({
    ids: createMockIdGenerator({ ulids: sequenceUlids(128) }),
  });
  const plan = createRecordingPlanStore(
    createPlanStore(createReadiness(recorder.events, INSTANCE)),
  );
  const objectiveCalls: ObjectiveCall[] = [];
  const closeCalls: CloseCall[] = [];
  const reportObjective: DelegatedReportObjective = (transaction, input) => {
    objectiveCalls.push({ transaction, input });
    probeNodeTitle(transaction, {
      id: fixtureIds.objective,
      title: "delegated_probe",
    });
    return cannedObjectiveResult(input);
  };
  const closeObjective: DelegatedCloseObjective = (transaction, input) => {
    closeCalls.push({ transaction, input });
    probeNodeTitle(transaction, {
      id: fixtureIds.objective,
      title: "delegated_probe",
    });
    return cannedCloseResult(input);
  };
  return {
    storage,
    plan,
    lease: createBackedLeaseFake(),
    execution,
    events: recorder.events,
    appends: recorder.appends,
    reportObjective,
    closeObjective,
    objectiveCalls,
    closeCalls,
    dispose() {
      temporary.dispose();
    },
  };
}

function seedReadyFixture(fixture: ReportFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

function seedTwoTaskFixture(
  fixture: ReportFixture,
  taskBState: "ready" | "pending" | "discarded",
): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedSecondRevisionWithTask(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
    seedNodeState(transaction, TASK_B, taskBState);
  });
}

// awaiting_approval and partial are schema-forbidden on a task row
// (migration 0002), so the fixture disables the CHECKs for those two writes
// and re-enables them immediately after.
function seedTaskState(fixture: ReportFixture, state: string): void {
  fixture.storage.transact((transaction) => {
    const bypassed = state === "awaiting_approval" || state === "partial";
    if (bypassed) {
      transaction.run("PRAGMA ignore_check_constraints = ON");
    }
    seedNodeState(transaction, fixtureIds.task, state);
    if (bypassed) {
      transaction.run("PRAGMA ignore_check_constraints = OFF");
    }
  });
}

function claim(
  fixture: ReportFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; actorId: string }>,
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
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: "harness",
      available: true,
    },
  );
}

type ReportInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind?: "human" | "harness";
  body: ReportBody;
}>;

function report(
  fixture: ReportFixture,
  clock: Clock,
  input: ReportInput,
): ReportOutcomeResult {
  return reportOutcome(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
      reportObjective: fixture.reportObjective,
      closeObjective: fixture.closeObjective,
      instanceId: INSTANCE,
    },
    {
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: input.actorKind ?? "harness",
      body: input.body,
    },
  );
}

function refused(
  fixture: ReportFixture,
  clock: Clock,
  input: ReportInput,
): ReportOutcomeError {
  let raised: unknown;
  try {
    report(fixture, clock, input);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof ReportOutcomeError,
    `expected ReportOutcomeError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: ReportFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function nodeTitle(fixture: ReportFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT title FROM node WHERE id = ?", [id]) as
      Readonly<{ title: string }> | undefined;
    return row?.title ?? "absent";
  });
}

function blockReasonOf(fixture: ReportFixture, id: string): string | null {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT block_reason FROM node WHERE id = ?", [
      id,
    ]) as Readonly<{ block_reason: string | null }> | undefined;
    return row?.block_reason ?? null;
  });
}

type RunRow = Readonly<{
  id: string;
  kind: string;
  node_id: string;
  parent_run_id: string | null;
  driver: string;
  lease_fence: number;
  attempt_limit: number;
  state: string;
  outcome: string | null;
  head_oid: string | null;
  ended_at: number | null;
}>;

function runRowOfNode(fixture: ReportFixture, nodeId: string): RunRow {
  return fixture.storage.transact((transaction) =>
    transaction.get(
      `SELECT id, kind, node_id, parent_run_id, driver, lease_fence, attempt_limit, state, outcome, head_oid, ended_at
FROM run
WHERE node_id = ?
ORDER BY id DESC LIMIT 1`,
      [nodeId],
    ),
  ) as RunRow;
}

type AttemptRow = Readonly<{
  id: string;
  run_id: string;
  attempt_no: number;
  outcome: string | null;
  head_oid: string | null;
}>;

function attemptRows(fixture: ReportFixture): readonly AttemptRow[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      "SELECT id, run_id, attempt_no, outcome, head_oid FROM attempt ORDER BY attempt_no ASC",
    ),
  ) as readonly AttemptRow[];
}

type LeaseRow = Readonly<{
  subject_kind: string;
  subject_id: string;
  owner: string | null;
  owner_kind: string | null;
  fence: number;
  acquired_at: number | null;
  renewed_at: number | null;
  expires_at: number | null;
}>;

function leaseRowOf(fixture: ReportFixture, subjectId: string): LeaseRow {
  return fixture.storage.transact((transaction) =>
    transaction.get(
      `SELECT subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at
FROM lease
WHERE subject_kind = 'node' AND subject_id = ?`,
      [subjectId],
    ),
  ) as LeaseRow;
}

function setNodeStateCalls(
  fixture: ReportFixture,
): readonly SetNodeStateInput[] {
  return fixture.plan.calls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

type MutableClock = Readonly<{ clock: Clock; advance(ms: number): void }>;

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

type WriteBaseline = Readonly<{
  appends: number;
  releases: number;
  states: number;
}>;

function baseline(fixture: ReportFixture): WriteBaseline {
  return {
    appends: fixture.appends.length,
    releases: fixture.lease.calls.filter((call) => call.name === "release")
      .length,
    states: setNodeStateCalls(fixture).length,
  };
}

function assertNoWrite(
  fixture: ReportFixture,
  bytes: Buffer,
  base: WriteBaseline,
): void {
  assert.deepEqual(databaseBytes(fixture.storage), bytes);
  assert.equal(fixture.appends.length, base.appends, "appends");
  assert.equal(
    fixture.lease.calls.filter((call) => call.name === "release").length,
    base.releases,
    "releases",
  );
  assert.equal(setNodeStateCalls(fixture).length, base.states, "setNodeState");
}

function driveOutcomeToLimit(
  fixture: ReportFixture,
  clock: Clock,
  outcome: "rejected" | "failed" | "cancelled",
): void {
  for (let index = 0; index < ATTEMPT_LIMIT; index++) {
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body:
        outcome === "cancelled"
          ? { report: outcome, fence: claimed.lease.fence }
          : { report: outcome, fence: claimed.lease.fence, reason: REASON },
    });
  }
}

function assertBlockedAtLimit(
  fixture: ReportFixture,
  outcome: "rejected" | "failed" | "cancelled",
): void {
  assert.equal(nodeState(fixture, fixtureIds.task), "blocked");
  assert.equal(blockReasonOf(fixture, fixtureIds.task), "attempt-limit");
  const run = runRowOfNode(fixture, fixtureIds.task);
  assert.equal(run.state, "ended");
  assert.equal(run.outcome, "blocked");
  const attempts = attemptRows(fixture);
  assert.deepEqual(
    attempts.map((row) => row.attempt_no),
    [1, 2, 3],
  );
  assert.ok(attempts.every((row) => row.outcome === outcome));
  const taskLease = leaseRowOf(fixture, fixtureIds.task);
  assert.equal(taskLease.owner, null);
  const objectiveRun = runRowOfNode(fixture, fixtureIds.objective);
  assert.equal(objectiveRun.state, "active");
  assert.equal(nodeState(fixture, fixtureIds.objective), "running");
}

function reportedAppends(fixture: ReportFixture): readonly RecordedAppend[] {
  return fixture.appends.filter(
    (record) => record.input.type === "outcome.reported",
  );
}

describe("src/commands/outcome/report-outcome.test", () => {
  it("attemptsRemaining clamps at zero", (t) => {
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      const claimed = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      const result = report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "rejected", fence: claimed.lease.fence, reason: "no" },
      });
      assert.equal(result.attemptsRemaining, 2);
    }
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      const claimed = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      fixture.storage.transact((transaction) => {
        for (let number = 2; number <= 4; number++) {
          transaction.run(
            `INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at)
VALUES (?, ?, 'external', ?, NULL, NULL, NULL, NULL, NULL, 'rejected', ?)`,
            [`attempt_extra_${number}`, claimed.runId, number, NOW],
          );
        }
      });
      const result = report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "rejected", fence: claimed.lease.fence, reason: "no" },
      });
      assert.equal(result.attemptsRemaining, 0);
    }
  });

  it("no task report touches the objective lease", (t) => {
    for (const outcome of [
      "accepted",
      "rejected",
      "failed",
      "cancelled",
    ] as const) {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      const claimed = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      const before = leaseRowOf(fixture, fixtureIds.objective);
      report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body:
          outcome === "accepted"
            ? {
                report: outcome,
                fence: claimed.lease.fence,
                objectId: OBJECT_ID,
              }
            : outcome === "cancelled"
              ? { report: outcome, fence: claimed.lease.fence }
              : { report: outcome, fence: claimed.lease.fence, reason: REASON },
      });
      assert.deepEqual(leaseRowOf(fixture, fixtureIds.objective), before);
    }
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedTwoTaskFixture(fixture, "ready");
      const clock = createMockClock({ start: NOW });
      const first = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: {
          report: "accepted",
          fence: first.lease.fence,
          objectId: OBJECT_ID,
        },
      });
      const second = claim(fixture, clock, {
        nodeId: TASK_B,
        actorId: ACTOR_A,
      });
      const before = leaseRowOf(fixture, fixtureIds.objective);
      report(fixture, clock, {
        nodeId: TASK_B,
        actorId: ACTOR_A,
        body: {
          report: "accepted",
          fence: second.lease.fence,
          objectId: OBJECT_ID,
        },
      });
      assert.deepEqual(leaseRowOf(fixture, fixtureIds.objective), before);
    }
  });

  it("a report on a task in each non-running state is illegal-transition", (t) => {
    for (const state of NON_RUNNING_STATES) {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      seedTaskState(fixture, state);
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "accepted", fence: 1, objectId: OBJECT_ID },
      });
      assert.equal(error.refusal, "illegal-transition");
      assert.deepEqual(error.details, { state, admitted: ["running"] });
      assertNoWrite(fixture, bytes, base);
    }
  });

  it("a wrong owner, a stale fence and an expired lease are each lease-held", (t) => {
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      claim(fixture, clock, { nodeId: fixtureIds.task, actorId: ACTOR_A });
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_B,
        body: { report: "rejected", fence: 1, reason: "no" },
      });
      assert.equal(error.refusal, "lease-held");
      assert.deepEqual(error.details, {
        subject: fixtureIds.task,
        holder: ACTOR_A,
        holderKind: "actor",
        fence: 1,
        expiresAt: NOW + TTL,
        relation: "self",
      });
      assertNoWrite(fixture, bytes, base);
    }
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      claim(fixture, clock, { nodeId: fixtureIds.task, actorId: ACTOR_A });
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "rejected", fence: 999, reason: "no" },
      });
      assert.equal(error.refusal, "lease-held");
      assert.equal(error.details, undefined);
      assertNoWrite(fixture, bytes, base);
    }
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const mutable = createMutableClock();
      claim(fixture, mutable.clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      mutable.advance(TTL + 1);
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, mutable.clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "rejected", fence: 1, reason: "no" },
      });
      assert.equal(error.refusal, "lease-held");
      assert.equal(error.details, undefined);
      assertNoWrite(fixture, bytes, base);
    }
  });

  it("a human actor is actor-forbidden", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const bytes = databaseBytes(fixture.storage);
    const base = baseline(fixture);
    const error = refused(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      actorKind: "human",
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(error.refusal, "actor-forbidden");
    assertNoWrite(fixture, bytes, base);
  });

  it("an initiative is initiative-not-reportable", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const bytes = databaseBytes(fixture.storage);
    const base = baseline(fixture);
    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      actorId: ACTOR_A,
      body: { report: "accepted", fence: 1, objectId: OBJECT_ID },
    });
    assert.equal(error.refusal, "initiative-not-reportable");
    assertNoWrite(fixture, bytes, base);
  });

  it("a task body on an objective and an objective body on a task are body-kind-mismatch", (t) => {
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.objective,
        actorId: ACTOR_A,
        body: { report: "accepted", fence: 1, objectId: OBJECT_ID },
      });
      assert.equal(error.refusal, "body-kind-mismatch");
      assertNoWrite(fixture, bytes, base);
    }
    {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const bytes = databaseBytes(fixture.storage);
      const base = baseline(fixture);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body: { report: "attested", fence: 1, objectId: OBJECT_ID },
      });
      assert.equal(error.refusal, "body-kind-mismatch");
      assertNoWrite(fixture, bytes, base);
    }
  });

  it("an objective with report attested delegates to reportObjective in the same transaction", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const result = report(fixture, clock, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
      body: {
        report: "attested",
        fence: claimed.objectiveLease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(fixture.objectiveCalls.length, 1);
    assert.equal(fixture.closeCalls.length, 0);
    const call = fixture.objectiveCalls[0]!;
    assert.deepEqual(call.input, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
      actorKind: "harness",
      fence: claimed.objectiveLease.fence,
      objectId: OBJECT_ID,
    });
    assert.equal(typeof call.transaction.get, "function");
    assert.equal(nodeTitle(fixture, fixtureIds.objective), "delegated_probe");
    assert.deepEqual(result, cannedObjectiveResult(call.input));
  });

  it("an objective with report closed delegates to closeObjective in the same transaction", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    claim(fixture, clock, { nodeId: fixtureIds.task, actorId: ACTOR_A });
    const result = report(fixture, clock, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
      body: { report: "closed", acknowledgePartial: false },
    });
    assert.equal(fixture.closeCalls.length, 1);
    assert.equal(fixture.objectiveCalls.length, 0);
    const call = fixture.closeCalls[0]!;
    assert.deepEqual(call.input, {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
      actorKind: "harness",
      acknowledgePartial: false,
    });
    assert.equal(typeof call.transaction.get, "function");
    assert.equal(nodeTitle(fixture, fixtureIds.objective), "delegated_probe");
    assert.deepEqual(result, cannedCloseResult(call.input));
  });

  it("objectiveProjection is done when every sibling task is terminal", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const result = report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(result.objectiveProjection, "done");
    assert.equal(result.objectiveState, "running");
  });

  it("objectiveProjection is partial when one sibling is discarded", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedTwoTaskFixture(fixture, "discarded");
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const result = report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(result.objectiveProjection, "partial");
    assert.equal(result.objectiveState, "running");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
  });

  it("objectiveProjection is null while one sibling is non-terminal", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedTwoTaskFixture(fixture, "pending");
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const result = report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(result.objectiveProjection, null);
    assert.equal(result.objectiveState, "running");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
  });

  it("a trigger that disagrees with the pair commits nothing", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const bytes = databaseBytes(fixture.storage);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "running",
            to: "ready",
            trigger: "outcome-accepted",
            blockReason: null,
            at: NOW,
            cause: { revision: fixtureIds.planRevision, importId: null },
          });
        }),
      /trigger outcome-accepted declares running -> done/,
    );
    assert.deepEqual(databaseBytes(fixture.storage), bytes);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "running",
            to: "done",
            trigger: "initiative-aggregated-done",
            blockReason: null,
            at: NOW,
            cause: { revision: fixtureIds.planRevision, importId: null },
          });
        }),
      /trigger initiative-aggregated-done declares levels initiative/,
    );
    assert.deepEqual(databaseBytes(fixture.storage), bytes);
  });

  it("an accepted task report promotes a dependent task", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSecondRevisionWithTask(transaction);
      seedEdge(transaction, {
        id: "edge_b_depends_a",
        fromNode: TASK_B,
        toNode: fixtureIds.task,
      });
      seedNodeState(transaction, fixtureIds.initiative, "ready");
      seedNodeState(transaction, fixtureIds.objective, "ready");
      seedNodeState(transaction, fixtureIds.task, "ready");
    });
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    assert.equal(nodeState(fixture, TASK_B), "ready");
    const readyEvents = fixture.appends.filter(
      (record) => record.input.type === "node.ready",
    );
    assert.equal(readyEvents.length, 1);
    assert.equal(readyEvents[0]!.input.subjectId, TASK_B);
    assert.equal(readyEvents[0]!.input.actorKind, "daemon");
    assert.equal(readyEvents[0]!.input.actorId, INSTANCE);
    const accepted = fixture.plan.calls.filter(
      (call) =>
        call.method === "setNodeState" &&
        (call.input as SetNodeStateInput).trigger === "outcome-accepted",
    );
    assert.equal(accepted.length, 1);
    assert.deepEqual(
      accepted[0]!.transitions.find(
        (transition) => transition.nodeId === TASK_B,
      ),
      {
        nodeId: TASK_B,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    );
    const reported = reportedAppends(fixture);
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.input.actorKind, "harness");
    assert.equal(readyEvents[0]!.transaction, reported[0]!.transaction);
  });

  it("a rejected, a failed and a cancelled report promote nothing", (t) => {
    for (const outcome of ["rejected", "failed", "cancelled"] as const) {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedTwoTaskFixture(fixture, "pending");
      fixture.storage.transact((transaction) => {
        seedEdge(transaction, {
          id: "edge_b_depends_a",
          fromNode: TASK_B,
          toNode: fixtureIds.task,
        });
      });
      const clock = createMockClock({ start: NOW });
      const claimed = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body:
          outcome === "cancelled"
            ? { report: outcome, fence: claimed.lease.fence }
            : { report: outcome, fence: claimed.lease.fence, reason: REASON },
      });
      assert.equal(nodeState(fixture, TASK_B), "pending", outcome);
      const readyEvents = fixture.appends.filter(
        (record) => record.input.type === "node.ready",
      );
      assert.equal(readyEvents.length, 0, outcome);
    }
  });

  it("the payload holds exactly nine keys in order", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    const payload = reportedAppends(fixture)[0]!.input.payload as Readonly<
      Record<string, unknown>
    >;
    assert.deepEqual(Object.keys(payload), [
      "runId",
      "attemptId",
      "attemptNo",
      "outcome",
      "reason",
      "objectId",
      "attemptsRemaining",
      "fromState",
      "toState",
    ]);
  });

  it("an accepted report records the object id and a null reason", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: {
        report: "accepted",
        fence: claimed.lease.fence,
        objectId: OBJECT_ID,
      },
    });
    const recorded = reportedAppends(fixture)[0]!.input;
    assert.deepEqual(recorded, {
      subjectKind: "node",
      subjectId: fixtureIds.task,
      type: "outcome.reported",
      actorKind: "harness",
      actorId: ACTOR_A,
      payload: {
        runId: claimed.runId,
        attemptId: claimed.attemptId,
        attemptNo: 1,
        outcome: "accepted",
        reason: null,
        objectId: OBJECT_ID,
        attemptsRemaining: 2,
        fromState: "running",
        toState: "done",
      },
    });
  });

  it("a rejected report stores its reason verbatim", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: { report: "rejected", fence: claimed.lease.fence, reason: REASON },
    });
    const payload = reportedAppends(fixture)[0]!.input.payload as Readonly<
      Record<string, unknown>
    >;
    assert.equal(payload.reason, REASON);
    assert.equal(payload.outcome, "rejected");
    assert.equal(payload.objectId, null);
    assert.equal(payload.toState, "ready");
  });

  it("a cancelled report with no reason stores null", (t) => {
    const fixture = createReportFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    report(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      body: { report: "cancelled", fence: claimed.lease.fence },
    });
    const payload = reportedAppends(fixture)[0]!.input.payload as Readonly<
      Record<string, unknown>
    >;
    assert.equal(payload.reason, null);
    assert.equal(payload.outcome, "cancelled");
  });

  it("exactly one outcome.reported event is appended per report", (t) => {
    for (const outcome of [
      "accepted",
      "rejected",
      "failed",
      "cancelled",
    ] as const) {
      const fixture = createReportFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      const claimed = claim(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      report(fixture, clock, {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
        body:
          outcome === "accepted"
            ? {
                report: outcome,
                fence: claimed.lease.fence,
                objectId: OBJECT_ID,
              }
            : outcome === "cancelled"
              ? { report: outcome, fence: claimed.lease.fence }
              : { report: outcome, fence: claimed.lease.fence, reason: REASON },
      });
      assert.equal(reportedAppends(fixture).length, 1);
    }
  });
});
