import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Clock } from "../../services/clock/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import type { Git } from "../../services/git/index.ts";
import type { SetNodeStateInput } from "../../services/plan/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import { sweepExpiredExternalLeases } from "../startup/recover-expired-leases.ts";
import { claimNode, type ClaimNodeResult } from "../node/claim-node.ts";
import {
  reportOutcome,
  type ReportOutcomeDependencies,
} from "./report-outcome.ts";
import type { NodeReportResult } from "../../domain/outcome-report.ts";
import {
  reportObjective,
  type ReportObjectiveDependencies,
  type ReportObjectiveInput,
  type ReportObjectiveResult,
} from "./report-objective.ts";
import type { AggregateInitiativeInput } from "./aggregate-initiative.ts";
import {
  closeObjective,
  CloseObjectiveError,
  type CloseObjectiveDependencies,
  type CloseObjectiveInput,
  type CloseObjectiveResult,
} from "./close-objective.ts";
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
  seedEdge,
  seedGraph,
  seedNode,
  seedNodeState,
  seedRegistry,
  seedWorkspaceOnNode,
} from "../../../test/helpers/rows.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
const ATTEMPT_LIMIT = 3;
const OBJECT_ID = "a".repeat(40);
const OBJECT_ID_B = "b".repeat(40);
const SIBLING_TASK = "task_b";
const NOT_AWAITING_STATES = [
  "pending",
  "ready",
  "running",
  "blocked",
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

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

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

type RecordedRollUpCall = Readonly<{
  transaction: Transaction;
  input: AggregateInitiativeInput;
}>;

type RollUpRecorder = Readonly<{
  fn: CloseObjectiveDependencies["aggregateInitiative"];
  calls: readonly RecordedRollUpCall[];
}>;

function createRecordingRollUp(): RollUpRecorder {
  const calls: RecordedRollUpCall[] = [];
  return {
    fn(transaction: Transaction, input: AggregateInitiativeInput): void {
      calls.push({ transaction, input });
    },
    calls,
  };
}

type CloseFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  appends: readonly RecordedAppend[];
  dispose(): void;
}>;

function createCloseFixture(): CloseFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const recorder = createRecordingEvents();
  const execution = createBackedExecutionFake({
    ids: createMockIdGenerator({ ulids: sequenceUlids(128) }),
  });
  const plan = createRecordingPlanStore(
    createPlanStore(createReadiness(recorder.events, INSTANCE)),
  );
  return {
    storage,
    plan,
    lease: createBackedLeaseFake(),
    execution,
    events: recorder.events,
    appends: recorder.appends,
    dispose() {
      temporary.dispose();
    },
  };
}

function seedReadyFixture(fixture: CloseFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

// A sibling task of the objective seeded discarded directly in the database,
// because no route of this block writes a discarded task. With the reported
// task done, the derived projection is partial.
function seedDiscardedSibling(fixture: CloseFixture): void {
  fixture.storage.transact((transaction) => {
    seedNode(transaction, {
      id: SIBLING_TASK,
      kind: "task",
      parentId: fixtureIds.objective,
      title: "Second task",
      acceptanceBlob: fixtureIds.acceptanceBlob,
      state: "discarded",
    });
  });
}

// A second objective under the same initiative that depends on the first
// objective. It stays pending while the first objective is awaiting_approval
// (which satisfies no dependency), so the close transaction is the first
// write that reads the graph back with the first objective done.
function seedDependentObjectiveFixture(fixture: CloseFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
    seedNode(transaction, {
      id: "objective_b",
      kind: "objective",
      parentId: fixtureIds.initiative,
      title: "Second objective",
      repositoryId: fixtureIds.repository,
      state: "pending",
    });
    seedEdge(transaction, {
      id: "edge_b_depends_a",
      fromNode: "objective_b",
      toNode: fixtureIds.objective,
    });
  });
}

function claim(
  fixture: CloseFixture,
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
      actorKind: "harness",
    },
  );
}

function reportTask(
  fixture: CloseFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; actorId: string; fence: number }>,
): void {
  const neverObjective: DelegatedReportObjective = () => {
    throw new Error("unexpected reportObjective call");
  };
  const neverClose: DelegatedCloseObjective = () => {
    throw new Error("unexpected closeObjective call");
  };
  reportOutcome(
    {
      storage: fixture.storage,
      plan: fixture.plan.plan,
      lease: fixture.lease.lease,
      execution: fixture.execution.execution,
      events: fixture.events,
      clock,
      reportObjective: neverObjective,
      closeObjective: neverClose,
      instanceId: INSTANCE,
    },
    {
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: "harness",
      body: { report: "accepted", fence: input.fence, objectId: OBJECT_ID },
    },
  );
}

function attest(
  fixture: CloseFixture,
  clock: Clock,
  input: ReportObjectiveInput,
): ReportObjectiveResult {
  const dependencies: ReportObjectiveDependencies = {
    plan: fixture.plan.plan,
    lease: fixture.lease.lease,
    execution: fixture.execution.execution,
    events: fixture.events,
    clock,
    instanceId: INSTANCE,
  };
  return fixture.storage.transact((transaction) =>
    reportObjective(dependencies, transaction, input),
  );
}

// The full route to awaiting_approval through the real claim, report and
// attestation commands: claim the task, report it accepted, attest the
// objective with the claimed objective fence.
function toAwaitingApproval(
  fixture: CloseFixture,
  clock: Clock,
): Readonly<{ taskFence: number; objectiveFence: number }> {
  const claimed = claim(fixture, clock, {
    nodeId: fixtureIds.task,
    actorId: ACTOR_A,
  });
  reportTask(fixture, clock, {
    nodeId: fixtureIds.task,
    actorId: ACTOR_A,
    fence: claimed.lease.fence,
  });
  attest(fixture, clock, {
    nodeId: fixtureIds.objective,
    actorId: ACTOR_A,
    actorKind: "harness",
    fence: claimed.objectiveLease.fence,
    objectId: OBJECT_ID_B,
  });
  return {
    taskFence: claimed.lease.fence,
    objectiveFence: claimed.objectiveLease.fence,
  };
}

function closeObjectiveNow(
  fixture: CloseFixture,
  clock: Clock,
  input: CloseObjectiveInput,
  rollUp: RollUpRecorder = createRecordingRollUp(),
  execution: Execution = fixture.execution.execution,
): CloseObjectiveResult {
  const dependencies: CloseObjectiveDependencies = {
    plan: fixture.plan.plan,
    execution,
    events: fixture.events,
    clock,
    aggregateInitiative: rollUp.fn,
    instanceId: INSTANCE,
  };
  return fixture.storage.transact((transaction) =>
    closeObjective(dependencies, transaction, input),
  );
}

function refusedClose(
  fixture: CloseFixture,
  clock: Clock,
  input: CloseObjectiveInput,
  rollUp: RollUpRecorder = createRecordingRollUp(),
): Readonly<{ error: CloseObjectiveError; rollUp: RollUpRecorder }> {
  let raised: unknown;
  try {
    closeObjectiveNow(fixture, clock, input, rollUp);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof CloseObjectiveError,
    `expected CloseObjectiveError, got ${String(raised)}`,
  );
  return { error: raised, rollUp };
}

function closeInput(
  overrides: Readonly<Partial<CloseObjectiveInput>> = {},
): CloseObjectiveInput {
  return {
    nodeId: fixtureIds.objective,
    actorId: ACTOR_A,
    actorKind: "human",
    acknowledgePartial: false,
    ...overrides,
  };
}

function nodeState(fixture: CloseFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function seedTaskStateDirect(fixture: CloseFixture, state: string): void {
  fixture.storage.transact((transaction) => {
    seedNodeState(transaction, fixtureIds.task, state);
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

function runRowOfNode(fixture: CloseFixture, nodeId: string): RunRow {
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

function setNodeStateCalls(
  fixture: CloseFixture,
): readonly SetNodeStateInput[] {
  return fixture.plan.calls
    .filter((call) => call.method === "setNodeState")
    .map((call) => call.input as SetNodeStateInput);
}

type WriteBaseline = Readonly<{
  appends: number;
  states: number;
  endRuns: number;
  rollUps: number;
}>;

function baseline(
  fixture: CloseFixture,
  rollUp: RollUpRecorder,
): WriteBaseline {
  return {
    appends: fixture.appends.length,
    states: setNodeStateCalls(fixture).length,
    endRuns: fixture.execution.endRunCalls.length,
    rollUps: rollUp.calls.length,
  };
}

function assertNoWrite(
  fixture: CloseFixture,
  bytes: Buffer,
  base: WriteBaseline,
): void {
  assert.deepEqual(databaseBytes(fixture.storage), bytes);
  assert.equal(fixture.appends.length, base.appends, "appends");
  assert.equal(setNodeStateCalls(fixture).length, base.states, "setNodeState");
  assert.equal(fixture.execution.endRunCalls.length, base.endRuns, "endRun");
}

function recordingGit(): Readonly<{ git: Git; calls: readonly string[] }> {
  const calls: string[] = [];
  const record = (name: string): never => {
    calls.push(name);
    throw new Error(`unexpected git call: ${name}`);
  };
  const git: Git = {
    remoteUrlVerdict(): never {
      return record("remoteUrlVerdict");
    },
    scanHostKeys(): Promise<never> {
      return Promise.resolve(record("scanHostKeys"));
    },
    confirmHostKey(): Promise<never> {
      return Promise.resolve(record("confirmHostKey"));
    },
    trustHostKey(): Promise<never> {
      return Promise.resolve(record("trustHostKey"));
    },
    seedHome(): Promise<never> {
      return Promise.resolve(record("seedHome"));
    },
    remoteInfo(): Promise<never> {
      return Promise.resolve(record("remoteInfo"));
    },
    canPush(): Promise<never> {
      return Promise.resolve(record("canPush"));
    },
    probePush(): Promise<never> {
      return Promise.resolve(record("probePush"));
    },
    fetch(): Promise<never> {
      return Promise.resolve(record("fetch"));
    },
    resolveRef(): Promise<never> {
      return Promise.resolve(record("resolveRef"));
    },
    refUpdate(): Promise<never> {
      return Promise.resolve(record("refUpdate"));
    },
    checkOutsideWriter(): Promise<never> {
      return Promise.resolve(record("checkOutsideWriter"));
    },
    clone(): Promise<never> {
      return Promise.resolve(record("clone"));
    },
    inspectChild(): Promise<never> {
      return Promise.resolve(record("inspectChild"));
    },
    stopChild(): Promise<never> {
      return Promise.resolve(record("stopChild"));
    },
    listPidFiles(): Promise<never> {
      return Promise.resolve(record("listPidFiles"));
    },
    removePidFile(): Promise<never> {
      return Promise.resolve(record("removePidFile"));
    },
    sweepHome(): Promise<never> {
      return Promise.resolve(record("sweepHome"));
    },
    worktreeClean(): Promise<never> {
      return Promise.resolve(record("worktreeClean"));
    },
  };
  return { git, calls };
}

function tableCount(fixture: CloseFixture, table: string): number {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get(
      `SELECT COUNT(*) AS n FROM ${table}`,
    ) as Readonly<{ n: number }>;
    return row.n;
  });
}

describe("src/commands/outcome/close-objective.test", () => {
  it("a close of a done projection writes done and ends the run", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const rollUp = createRecordingRollUp();
    const result = closeObjectiveNow(fixture, clock, closeInput(), rollUp);
    assert.equal(nodeState(fixture, fixtureIds.objective), "done");
    const run = runRowOfNode(fixture, fixtureIds.objective);
    assert.equal(run.state, "ended");
    assert.equal(run.outcome, "done");
    assert.equal(run.ended_at, NOW);
    assert.equal(run.head_oid, OBJECT_ID_B);
    assert.equal(rollUp.calls.length, 1);
    assert.deepEqual(rollUp.calls[0]!.input, {
      initiativeId: fixtureIds.initiative,
      at: NOW,
    });
    assert.deepEqual(result, {
      nodeId: fixtureIds.objective,
      kind: "objective",
      state: "done",
      blockReason: null,
      attemptId: null,
      attemptNo: null,
      attemptsRemaining: null,
      objectId: OBJECT_ID_B,
      objectiveState: "done",
      objectiveProjection: "done",
    } satisfies NodeReportResult);
  });

  it("the decision table holds row by row", (t) => {
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      const before = setNodeStateCalls(fixture).length;
      const rollUp = createRecordingRollUp();
      const result = closeObjectiveNow(
        fixture,
        clock,
        closeInput({ acknowledgePartial: false }),
        rollUp,
      );
      assert.equal(result.state, "done");
      assert.equal(nodeState(fixture, fixtureIds.objective), "done");
      const calls = setNodeStateCalls(fixture).slice(before);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.trigger, "human-close");
      assert.equal(runRowOfNode(fixture, fixtureIds.objective).outcome, "done");
      assert.equal(rollUp.calls.length, 1);
      assert.equal(
        fixture.appends.filter((record) => record.input.type === "node.done")
          .length,
        1,
      );
    }
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      const before = setNodeStateCalls(fixture).length;
      const rollUp = createRecordingRollUp();
      const result = closeObjectiveNow(
        fixture,
        clock,
        closeInput({ acknowledgePartial: true }),
        rollUp,
      );
      assert.equal(result.state, "done");
      assert.equal(nodeState(fixture, fixtureIds.objective), "done");
      const calls = setNodeStateCalls(fixture).slice(before);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.trigger, "human-close");
      assert.equal(runRowOfNode(fixture, fixtureIds.objective).outcome, "done");
      assert.equal(rollUp.calls.length, 1);
    }
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      seedDiscardedSibling(fixture);
      const before = setNodeStateCalls(fixture).length;
      const rollUp = createRecordingRollUp();
      const result = closeObjectiveNow(
        fixture,
        clock,
        closeInput({ acknowledgePartial: true }),
        rollUp,
      );
      assert.equal(result.state, "partial");
      assert.equal(nodeState(fixture, fixtureIds.objective), "partial");
      const calls = setNodeStateCalls(fixture).slice(before);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.trigger, "human-close-partial");
      assert.equal(
        runRowOfNode(fixture, fixtureIds.objective).outcome,
        "partial",
      );
      assert.equal(rollUp.calls.length, 1);
      assert.equal(
        fixture.appends.filter((record) => record.input.type === "node.partial")
          .length,
        1,
      );
    }
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      seedDiscardedSibling(fixture);
      const bytes = databaseBytes(fixture.storage);
      const rollUp = createRecordingRollUp();
      const base = baseline(fixture, rollUp);
      const { error, rollUp: refusedRollUp } = refusedClose(
        fixture,
        clock,
        closeInput({ acknowledgePartial: false }),
        rollUp,
      );
      assert.equal(error.refusal, "acknowledgement-required");
      assert.equal(
        nodeState(fixture, fixtureIds.objective),
        "awaiting_approval",
      );
      assertNoWrite(fixture, bytes, base);
      assert.equal(refusedRollUp.calls.length, base.rollUps);
    }
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      seedTaskStateDirect(fixture, "discarded");
      const bytes = databaseBytes(fixture.storage);
      const rollUp = createRecordingRollUp();
      const base = baseline(fixture, rollUp);
      const { error, rollUp: refusedRollUp } = refusedClose(
        fixture,
        clock,
        closeInput({ acknowledgePartial: true }),
        rollUp,
      );
      assert.equal(error.refusal, "illegal-transition");
      assert.equal(
        nodeState(fixture, fixtureIds.objective),
        "awaiting_approval",
      );
      assertNoWrite(fixture, bytes, base);
      assert.equal(refusedRollUp.calls.length, base.rollUps);
    }
  });

  it("acknowledgePartial is ignored on a done projection", (t) => {
    for (const acknowledgePartial of [false, true]) {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      const rollUp = createRecordingRollUp();
      const result = closeObjectiveNow(
        fixture,
        clock,
        closeInput({ acknowledgePartial }),
        rollUp,
      );
      assert.equal(result.state, "done");
      assert.equal(nodeState(fixture, fixtureIds.objective), "done");
      assert.equal(runRowOfNode(fixture, fixtureIds.objective).outcome, "done");
      assert.equal(rollUp.calls.length, 1);
    }
  });

  it("a derived discarded projection is illegal-transition", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    seedTaskStateDirect(fixture, "discarded");
    const bytes = databaseBytes(fixture.storage);
    const rollUp = createRecordingRollUp();
    const base = baseline(fixture, rollUp);
    const { error, rollUp: refusedRollUp } = refusedClose(
      fixture,
      clock,
      closeInput(),
      rollUp,
    );
    assert.equal(error.refusal, "illegal-transition");
    assertNoWrite(fixture, bytes, base);
    assert.equal(refusedRollUp.calls.length, base.rollUps);
  });

  it("a derived partial with no acknowledgement is acknowledgement-required", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    seedDiscardedSibling(fixture);
    const bytes = databaseBytes(fixture.storage);
    const refusedRollUp = createRecordingRollUp();
    const base = baseline(fixture, refusedRollUp);
    const { error } = refusedClose(
      fixture,
      clock,
      closeInput({ acknowledgePartial: false }),
      refusedRollUp,
    );
    assert.equal(error.refusal, "acknowledgement-required");
    assert.equal(nodeState(fixture, fixtureIds.objective), "awaiting_approval");
    assertNoWrite(fixture, bytes, base);
    assert.equal(refusedRollUp.calls.length, base.rollUps);
    const answeredRollUp = createRecordingRollUp();
    const result = closeObjectiveNow(
      fixture,
      clock,
      closeInput({ acknowledgePartial: true }),
      answeredRollUp,
    );
    assert.equal(result.state, "partial");
    assert.equal(nodeState(fixture, fixtureIds.objective), "partial");
    assert.equal(
      runRowOfNode(fixture, fixtureIds.objective).outcome,
      "partial",
    );
    assert.equal(answeredRollUp.calls.length, 1);
  });

  it("a close of an objective that is not awaiting_approval is illegal-transition", (t) => {
    for (const state of NOT_AWAITING_STATES) {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      fixture.storage.transact((transaction) => {
        seedNodeState(transaction, fixtureIds.objective, state);
      });
      const bytes = databaseBytes(fixture.storage);
      const rollUp = createRecordingRollUp();
      const base = baseline(fixture, rollUp);
      const { error, rollUp: refusedRollUp } = refusedClose(
        fixture,
        createMockClock({ start: NOW }),
        closeInput(),
        rollUp,
      );
      assert.equal(error.refusal, "illegal-transition");
      assert.deepEqual(error.details, {
        state,
        admitted: ["awaiting_approval"],
      });
      assertNoWrite(fixture, bytes, base);
      assert.equal(refusedRollUp.calls.length, base.rollUps);
    }
  });

  it("a close of an objective whose run driver is internal is illegal-transition", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const runId = runRowOfNode(fixture, fixtureIds.objective).id;
    fixture.storage.transact((transaction) => {
      seedWorkspaceOnNode(transaction, {
        id: "workspace_a",
        nodeId: fixtureIds.objective,
      });
      transaction.run(
        "UPDATE run SET driver = 'internal', workspace_id = 'workspace_a', worker = 'general@1', base_oid = ? WHERE id = ?",
        ["a".repeat(40), runId],
      );
    });
    const bytes = databaseBytes(fixture.storage);
    const rollUp = createRecordingRollUp();
    const base = baseline(fixture, rollUp);
    const { error, rollUp: refusedRollUp } = refusedClose(
      fixture,
      clock,
      closeInput(),
      rollUp,
    );
    assert.equal(error.refusal, "illegal-transition");
    assertNoWrite(fixture, bytes, base);
    assert.equal(refusedRollUp.calls.length, base.rollUps);
  });

  it("a close of an objective whose run head_oid is null is illegal-transition", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const runId = runRowOfNode(fixture, fixtureIds.objective).id;
    fixture.storage.transact((transaction) => {
      transaction.run("UPDATE run SET head_oid = NULL WHERE id = ?", [runId]);
    });
    const bytes = databaseBytes(fixture.storage);
    const rollUp = createRecordingRollUp();
    const base = baseline(fixture, rollUp);
    const { error, rollUp: refusedRollUp } = refusedClose(
      fixture,
      clock,
      closeInput(),
      rollUp,
    );
    assert.equal(error.refusal, "illegal-transition");
    assertNoWrite(fixture, bytes, base);
    assert.equal(refusedRollUp.calls.length, base.rollUps);
  });

  it("a harness actor is actor-forbidden", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const bytes = databaseBytes(fixture.storage);
    const rollUp = createRecordingRollUp();
    const base = baseline(fixture, rollUp);
    const { error, rollUp: refusedRollUp } = refusedClose(
      fixture,
      clock,
      closeInput({ actorKind: "harness" }),
      rollUp,
    );
    assert.equal(error.refusal, "actor-forbidden");
    assertNoWrite(fixture, bytes, base);
    assert.equal(refusedRollUp.calls.length, base.rollUps);
  });

  it("the close writes no candidate, calls no git and writes no check or invocation row", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const git = recordingGit();
    closeObjectiveNow(fixture, clock, closeInput());
    assert.equal(git.calls.length, 0);
    assert.deepEqual(
      {
        candidate: tableCount(fixture, "candidate"),
        check_result: tableCount(fixture, "check_result"),
        agent_invocation: tableCount(fixture, "agent_invocation"),
      },
      { candidate: 0, check_result: 0, agent_invocation: 0 },
    );
  });

  it("the initiative roll-up runs before the run ends", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    const runId = runRowOfNode(fixture, fixtureIds.objective).id;
    const order: string[] = [];
    const runStateAtRollUp: string[] = [];
    const rollUp: CloseObjectiveDependencies["aggregateInitiative"] = (
      transaction,
      _input,
    ) => {
      order.push("aggregateInitiative");
      const row = transaction.get("SELECT state FROM run WHERE id = ?", [
        runId,
      ]) as Readonly<{ state: string }>;
      runStateAtRollUp.push(row.state);
    };
    const execution: Execution = {
      ...fixture.execution.execution,
      endRun(transaction, input) {
        order.push("endRun");
        return fixture.execution.execution.endRun(transaction, input);
      },
    };
    closeObjectiveNow(
      fixture,
      clock,
      closeInput(),
      { fn: rollUp, calls: [] },
      execution,
    );
    assert.deepEqual(order, ["aggregateInitiative", "endRun"]);
    assert.deepEqual(runStateAtRollUp, ["active"]);
    assert.equal(runRowOfNode(fixture, fixtureIds.objective).state, "ended");
  });

  it("the trigger is human-close or human-close-partial", (t) => {
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      const before = setNodeStateCalls(fixture).length;
      closeObjectiveNow(fixture, clock, closeInput());
      const calls = setNodeStateCalls(fixture).slice(before);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        {
          id: calls[0]!.id,
          from: calls[0]!.from,
          to: calls[0]!.to,
          trigger: calls[0]!.trigger,
        },
        {
          id: fixtureIds.objective,
          from: "awaiting_approval",
          to: "done",
          trigger: "human-close",
        },
      );
    }
    {
      const fixture = createCloseFixture();
      t.after(() => fixture.dispose());
      seedReadyFixture(fixture);
      const clock = createMockClock({ start: NOW });
      toAwaitingApproval(fixture, clock);
      seedDiscardedSibling(fixture);
      const before = setNodeStateCalls(fixture).length;
      closeObjectiveNow(
        fixture,
        clock,
        closeInput({ acknowledgePartial: true }),
      );
      const calls = setNodeStateCalls(fixture).slice(before);
      assert.equal(calls.length, 1);
      assert.deepEqual(
        {
          id: calls[0]!.id,
          from: calls[0]!.from,
          to: calls[0]!.to,
          trigger: calls[0]!.trigger,
        },
        {
          id: fixtureIds.objective,
          from: "awaiting_approval",
          to: "partial",
          trigger: "human-close-partial",
        },
      );
    }
  });

  it("a trigger that disagrees with the pair commits nothing", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const bytes = databaseBytes(fixture.storage);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "running",
            to: "done",
            trigger: "human-close",
            blockReason: null,
            at: NOW,
            cause: { revision: fixtureIds.planRevision, importId: null },
          });
        }),
      /trigger human-close declares awaiting_approval -> done/,
    );
    assert.deepEqual(databaseBytes(fixture.storage), bytes);
    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.plan.plan.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "awaiting_approval",
            to: "done",
            trigger: "human-close",
            blockReason: null,
            at: NOW,
            cause: { revision: fixtureIds.planRevision, importId: null },
          });
        }),
      /not in the transition matrix/,
    );
    assert.deepEqual(databaseBytes(fixture.storage), bytes);
  });

  it("the event names the closing human", (t) => {
    const fixture = createCloseFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(fixture, clock);
    closeObjectiveNow(fixture, clock, closeInput());
    const done = fixture.appends.filter(
      (record) => record.input.type === "node.done",
    );
    assert.equal(done.length, 1);
    const run = runRowOfNode(fixture, fixtureIds.objective);
    assert.deepEqual(done[0]!.input, {
      subjectKind: "node",
      subjectId: fixtureIds.objective,
      type: "node.done",
      actorKind: "human",
      actorId: ACTOR_A,
      payload: {
        from: "awaiting_approval",
        to: "done",
        reason: "human-close",
        objectId: OBJECT_ID_B,
        objectiveRunId: run.id,
        acknowledgePartial: false,
      },
    });
    const payload = done[0]!.input.payload as Readonly<Record<string, unknown>>;
    assert.deepEqual(Object.keys(payload), [
      "from",
      "to",
      "reason",
      "objectId",
      "objectiveRunId",
      "acknowledgePartial",
    ]);
  });

  it("the close promotes a dependent objective", (t) => {
    const doneFixture = createCloseFixture();
    t.after(() => doneFixture.dispose());
    seedDependentObjectiveFixture(doneFixture);
    const clock = createMockClock({ start: NOW });
    toAwaitingApproval(doneFixture, clock);
    assert.equal(nodeState(doneFixture, "objective_b"), "pending");
    closeObjectiveNow(doneFixture, clock, closeInput());
    assert.equal(nodeState(doneFixture, "objective_b"), "ready");
    const ready = doneFixture.appends.filter(
      (record) => record.input.type === "node.ready",
    );
    assert.equal(ready.length, 1);
    assert.equal(ready[0]!.input.subjectId, "objective_b");
    assert.equal(ready[0]!.input.actorKind, "daemon");
    assert.equal(ready[0]!.input.actorId, INSTANCE);
    const closed = doneFixture.appends.filter(
      (record) => record.input.type === "node.done",
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.input.actorKind, "human");
    assert.equal(closed[0]!.transaction, ready[0]!.transaction);

    const partialFixture = createCloseFixture();
    t.after(() => partialFixture.dispose());
    seedDependentObjectiveFixture(partialFixture);
    seedDiscardedSibling(partialFixture);
    const partialClock = createMockClock({ start: NOW });
    toAwaitingApproval(partialFixture, partialClock);
    assert.equal(nodeState(partialFixture, "objective_b"), "pending");
    closeObjectiveNow(
      partialFixture,
      partialClock,
      closeInput({ acknowledgePartial: true }),
    );
    assert.equal(nodeState(partialFixture, fixtureIds.objective), "partial");
    assert.equal(nodeState(partialFixture, "objective_b"), "ready");
    const partialReady = partialFixture.appends.filter(
      (record) => record.input.type === "node.ready",
    );
    assert.equal(partialReady.length, 1);
    assert.equal(partialReady[0]!.input.subjectId, "objective_b");
    assert.equal(partialReady[0]!.input.actorKind, "daemon");
    assert.equal(partialReady[0]!.input.actorId, INSTANCE);
    const partial = partialFixture.appends.filter(
      (record) => record.input.type === "node.partial",
    );
    assert.equal(partial.length, 1);
    assert.equal(partial[0]!.transaction, partialReady[0]!.transaction);
  });
});
