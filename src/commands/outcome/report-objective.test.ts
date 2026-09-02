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
import {
  reportOutcome,
  type ReportOutcomeDependencies,
} from "./report-outcome.ts";
import type { NodeReportResult } from "../../domain/outcome-report.ts";
import {
  reportObjective,
  ReportObjectiveError,
  type ReportObjectiveDependencies,
  type ReportObjectiveInput,
  type ReportObjectiveResult,
} from "./report-objective.ts";
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
} from "../../../test/helpers/rows.ts";
import { workerRegistry } from "../../domain/worker-registry.ts";

const NOW = 1700000000000;
const TTL = 300000;
const INSTANCE = "daemon_instance_a";
const ACTOR_A = "actor_alpha";
const ACTOR_B = "actor_beta";
const ATTEMPT_LIMIT = 3;
const OBJECT_ID = "a".repeat(40);
const OBJECT_ID_B = "b".repeat(40);
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

type ReportObjectiveFixture = Readonly<{
  storage: Storage;
  plan: ReturnType<typeof createRecordingPlanStore>;
  lease: BackedLeaseFake;
  execution: BackedExecutionFake;
  events: EventLog;
  appends: readonly RecordedAppend[];
  dispose(): void;
}>;

function createReportObjectiveFixture(): ReportObjectiveFixture {
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

function seedReadyFixture(fixture: ReportObjectiveFixture): void {
  fixture.storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    seedNodeState(transaction, fixtureIds.initiative, "ready");
    seedNodeState(transaction, fixtureIds.objective, "ready");
    seedNodeState(transaction, fixtureIds.task, "ready");
  });
}

// A second objective under the same initiative whose one task depends on the
// first objective's task. The dependent task is seeded pending directly, so
// no readiness pass ever ran over its satisfied dependency; the attestation
// transaction is the first write that reads the graph back.
function seedDependentSecondObjectiveFixture(
  fixture: ReportObjectiveFixture,
): void {
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
      state: "ready",
    });
    seedNode(transaction, {
      id: "task_b2",
      kind: "task",
      parentId: "objective_b",
      title: "Second task",
      acceptanceBlob: fixtureIds.acceptanceBlob,
      state: "pending",
    });
    seedEdge(transaction, {
      id: "edge_b2_depends_a",
      fromNode: "task_b2",
      toNode: fixtureIds.task,
    });
  });
}

// A second objective under the same initiative that depends on the first
// objective. It stays pending while the objective is running or
// awaiting_approval, because neither state satisfies a dependency, so the
// attestation promotes nothing.
function seedDependentObjectiveFixture(fixture: ReportObjectiveFixture): void {
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
  fixture: ReportObjectiveFixture,
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

function reportTask(
  fixture: ReportObjectiveFixture,
  clock: Clock,
  input: Readonly<{ nodeId: string; actorId: string; fence: number }>,
): void {
  const never: DelegatedReportObjective = () => {
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
      reportObjective: never,
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
  fixture: ReportObjectiveFixture,
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

function refused(
  fixture: ReportObjectiveFixture,
  clock: Clock,
  input: ReportObjectiveInput,
): ReportObjectiveError {
  let raised: unknown;
  try {
    attest(fixture, clock, input);
  } catch (error) {
    raised = error;
  }
  assert.ok(
    raised instanceof ReportObjectiveError,
    `expected ReportObjectiveError, got ${String(raised)}`,
  );
  return raised;
}

function nodeState(fixture: ReportObjectiveFixture, id: string): string {
  return fixture.storage.transact((transaction) => {
    const row = transaction.get("SELECT state FROM node WHERE id = ?", [id]) as
      Readonly<{ state: string }> | undefined;
    return row?.state ?? "absent";
  });
}

function seedTaskStateDirect(
  fixture: ReportObjectiveFixture,
  state: string,
): void {
  fixture.storage.transact((transaction) => {
    seedNodeState(transaction, fixtureIds.task, state);
  });
}

function completeTaskThroughStore(fixture: ReportObjectiveFixture): void {
  fixture.storage.transact((transaction) => {
    const node = fixture.plan.plan.readNode(transaction, fixtureIds.task);
    assert.ok(node !== null);
    fixture.plan.plan.setNodeState(transaction, {
      id: node.id,
      from: "running",
      to: "done",
      trigger: "outcome-accepted",
      blockReason: null,
      at: NOW,
      cause: { revision: node.revision, importId: null },
    });
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

function runRowOfNode(fixture: ReportObjectiveFixture, nodeId: string): RunRow {
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

function leaseRowOf(
  fixture: ReportObjectiveFixture,
  subjectId: string,
): LeaseRow {
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
  fixture: ReportObjectiveFixture,
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

function baseline(fixture: ReportObjectiveFixture): WriteBaseline {
  return {
    appends: fixture.appends.length,
    releases: fixture.lease.calls.filter((call) => call.name === "release")
      .length,
    states: setNodeStateCalls(fixture).length,
  };
}

function assertNoWrite(
  fixture: ReportObjectiveFixture,
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

function attestationInput(
  overrides: Readonly<Partial<ReportObjectiveInput>> = {},
): ReportObjectiveInput {
  return {
    nodeId: fixtureIds.objective,
    actorId: ACTOR_A,
    actorKind: "harness",
    fence: 1,
    objectId: OBJECT_ID_B,
    ...overrides,
  };
}

function attestedAppends(
  fixture: ReportObjectiveFixture,
): readonly RecordedAppend[] {
  return fixture.appends.filter(
    (record) => record.input.type === "node.awaitingApproval",
  );
}

describe("src/commands/outcome/report-objective.test", () => {
  it("a human actor is actor-forbidden", (t) => {
    const fixture = createReportObjectiveFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const claimed = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const bytes = databaseBytes(fixture.storage);
    const base = baseline(fixture);
    const error = refused(
      fixture,
      clock,
      attestationInput({
        actorKind: "human",
        fence: claimed.objectiveLease.fence,
      }),
    );
    assert.equal(error.refusal, "actor-forbidden");
    assertNoWrite(fixture, bytes, base);
  });
});
