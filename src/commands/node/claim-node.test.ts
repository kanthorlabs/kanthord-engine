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
import { expireRuns } from "../run/expire-runs.ts";
import {
  claimNode,
  claimRefusalCodes,
  ClaimNodeError,
  type ClaimRefusal,
  type ClaimNodeResult,
} from "./claim-node.ts";
import { reportOutcome } from "../outcome/report-outcome.ts";
import { nodeClaimRequest } from "../../http/contract/execution.ts";
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
  seedNodeWorker,
  seedRegistry,
  seedRunRow,
  seedSecondProjectGraph,
  seedSecondRevisionWithTask,
  seedSiblingObjective,
  seedWorkspaceOnNode,
} from "../../../test/helpers/rows.ts";
import { workerRegistry } from "../../domain/worker-registry.ts";
import type { WorkerEntry } from "../../domain/worker-registry.ts";
import { expansionCapableRegistry } from "../../../test/helpers/worker-registry.ts";

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
  callerWorker?: string;
  authorizedWorkers?: readonly string[];
  registry?: readonly WorkerEntry[];
  available?: boolean;
  runTtlMs?: number;
  runMaxLifetimeMs?: number;
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
      expiry: {
        expireRuns(
          transaction: Transaction,
          expiryInput: Readonly<{ now: number }>,
        ) {
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
      callerRecord: {
        worker: input.callerWorker ?? "claude@1",
        authorized: input.authorizedWorkers ?? [
          input.callerWorker ?? "claude@1",
        ],
      },
      registry: input.registry ?? workerRegistry,
      attemptLimit: ATTEMPT_LIMIT,
      leaseTtlMs: TTL,
      runTtlMs: input.runTtlMs ?? 120000,
      runMaxLifetimeMs: input.runMaxLifetimeMs ?? 900000,
      instanceId: INSTANCE,
    },
    {
      nodeId: input.nodeId,
      actorId: input.actorId,
      actorKind: input.actorKind ?? "harness",
      available: input.available ?? true,
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

const CLAIM_REFUSAL_ORDER = [
  "node-not-found",
  "pair-illegal",
  "plan-incomplete",
  "assignment-held",
  "unroutable",
  "review-head-unavailable",
  "lease-held",
  "drive-mode-pinned",
  "subtree-busy",
  "illegal-transition",
  "ancestor-not-startable",
] as const satisfies readonly ClaimRefusal[];

const EXTENDED_CLAIM_REFUSAL_ORDER = [
  "node-not-found",
  "pair-illegal",
  "plan-incomplete",
  "assignment-held",
  "unroutable",
  "review-head-unavailable",
  "lease-held",
  "drive-mode-pinned",
  "objective-busy",
  "subtree-busy",
  "illegal-transition",
  "ancestor-not-startable",
] as const satisfies readonly ClaimRefusal[];

const OBJECTIVE_BUSY_COMPANIONS = [
  "assignment-held",
  "unroutable",
  "lease-held",
  "drive-mode-pinned",
  "subtree-busy",
  "illegal-transition",
  "ancestor-not-startable",
] as const satisfies readonly ClaimRefusal[];

type DecisionRefusal = (typeof CLAIM_REFUSAL_ORDER)[number];

function projectClaimNodes(
  fixture: ClaimFixture,
  transform: (
    nodes: readonly ReturnType<PlanStoreReadAllNodes>[number][],
  ) => readonly ReturnType<PlanStoreReadAllNodes>[number][],
): void {
  const readAllNodes = fixture.plan.plan.readAllNodes;
  fixture.plan.plan.readAllNodes = (transaction) =>
    transform(readAllNodes(transaction));
}

type PlanStoreReadAllNodes = ClaimFixture["plan"]["plan"]["readAllNodes"];

function seedDecisionLease(fixture: ClaimFixture, nodeId: string): void {
  fixture.storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'actor', 1, ?, ?, ?)",
      [nodeId, ACTOR_A, NOW, NOW, NOW + TTL],
    );
  });
}

function seedDecisionRun(
  fixture: ClaimFixture,
  nodeId: string,
  internal: boolean,
): void {
  fixture.storage.transact((transaction) => {
    if (internal) {
      seedWorkspaceOnNode(transaction, {
        id: "workspace_pair",
        nodeId,
      });
      seedRunRow(transaction, {
        id: "run_internal_pair",
        kind: "objective",
        nodeId,
        parentRunId: null,
        workspaceId: "workspace_pair",
      });
      return;
    }
    fixture.execution.execution.openRun(transaction, {
      nodeId,
      kind: "structural",
      workspaceId: null,
      worker: "claude@1",
      attemptLimit: ATTEMPT_LIMIT,
      fence: 1,
      judgedOid: null,
      graphRevision: REVISION_A,
      agents: [],
      expiresAt: NOW + TTL,
      maxLifetimeAt: NOW + TTL,
    });
  });
}

function seedObjectiveBusySibling(fixture: ClaimFixture): void {
  fixture.storage.transact((transaction) => {
    fixture.execution.execution.openRun(transaction, {
      nodeId: TASK_B,
      kind: "execution",
      workspaceId: null,
      worker: "general@1",
      attemptLimit: ATTEMPT_LIMIT,
      fence: 3,
      judgedOid: null,
      graphRevision: REVISION_A,
      agents: [],
      expiresAt: NOW + TTL,
      maxLifetimeAt: NOW + TTL,
    });
  });
}

function prepareObjectiveBusyPair(
  fixture: ClaimFixture,
  companion: (typeof OBJECTIVE_BUSY_COMPANIONS)[number],
): ClaimInput {
  seedReadySiblingFixture(fixture);
  seedObjectiveBusySibling(fixture);

  if (companion === "assignment-held") {
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "tdd@1",
      });
    });
  }
  if (companion === "lease-held") seedDecisionLease(fixture, fixtureIds.task);
  if (companion === "drive-mode-pinned") {
    seedDecisionRun(fixture, fixtureIds.objective, true);
  }
  if (companion === "subtree-busy") {
    seedDecisionRun(fixture, fixtureIds.objective, false);
  }
  if (companion === "illegal-transition") {
    fixture.storage.transact((transaction) =>
      seedNodeState(transaction, fixtureIds.task, "done"),
    );
  }
  if (companion === "ancestor-not-startable") {
    fixture.storage.transact((transaction) =>
      seedNodeState(transaction, fixtureIds.objective, "done"),
    );
  }

  return {
    nodeId: fixtureIds.task,
    actorId: companion === "lease-held" ? ACTOR_B : ACTOR_A,
    callerWorker: companion === "assignment-held" ? "general@1" : undefined,
    available: companion === "unroutable" ? false : true,
  };
}

function prepareDecisionPair(
  fixture: ClaimFixture,
  pair: readonly [DecisionRefusal, DecisionRefusal],
): ClaimInput {
  seedReadyFixture(fixture);
  const includes = (refusal: DecisionRefusal): boolean =>
    pair[0] === refusal || pair[1] === refusal;
  const targetId =
    includes("pair-illegal") && includes("review-head-unavailable")
      ? fixtureIds.initiative
      : fixtureIds.task;
  const objectiveId =
    targetId === fixtureIds.task ? fixtureIds.objective : targetId;

  if (includes("pair-illegal")) {
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === targetId
          ? {
              ...node,
              deliverable:
                targetId === fixtureIds.initiative ? "review" : "expansion",
            }
          : node,
      ),
    );
  }
  if (includes("plan-incomplete")) {
    projectClaimNodes(fixture, (nodes) =>
      targetId === fixtureIds.task
        ? nodes.map((node) =>
            node.id === fixtureIds.objective
              ? { ...node, kind: "initiative" }
              : node,
          )
        : nodes.filter((node) => node.id !== fixtureIds.objective),
    );
  }
  if (includes("review-head-unavailable")) {
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === targetId ? { ...node, deliverable: "review" } : node,
      ),
    );
  }
  if (includes("assignment-held")) {
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: targetId,
        assignment: "tdd@1",
      });
    });
  }
  if (includes("lease-held")) seedDecisionLease(fixture, targetId);
  if (includes("drive-mode-pinned")) {
    seedDecisionRun(fixture, objectiveId, true);
  }
  if (includes("subtree-busy") && !includes("drive-mode-pinned")) {
    seedDecisionRun(fixture, objectiveId, false);
  }
  if (includes("illegal-transition")) {
    fixture.storage.transact((transaction) =>
      seedNodeState(transaction, targetId, "done"),
    );
  }
  if (includes("ancestor-not-startable") && targetId === fixtureIds.task) {
    fixture.storage.transact((transaction) =>
      seedNodeState(transaction, fixtureIds.objective, "done"),
    );
  }
  if (includes("node-not-found")) {
    projectClaimNodes(fixture, (nodes) =>
      nodes.filter((node) => node.id !== targetId),
    );
  }

  return {
    nodeId: targetId,
    actorId: includes("lease-held") ? ACTOR_B : ACTOR_A,
    callerWorker: includes("assignment-held") ? "general@1" : undefined,
    available: includes("unroutable") ? false : true,
  };
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
  driver: string;
  workspace_id: string | null;
  worker: string;
  fence: number;
  attempt_limit: number;
  head_oid: string | null;
  judged_oid: string | null;
  graph_revision: string | null;
  agents_json: string;
  expires_at: number;
  max_lifetime_at: number;
  state: string;
  outcome: string | null;
  ended_at: number | null;
}>[] {
  return fixture.storage.transact((transaction) =>
    transaction.all(
      `SELECT id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at
 FROM run
 ORDER BY id`,
    ),
  ) as readonly Readonly<{
    id: string;
    kind: string;
    node_id: string;
    driver: string;
    workspace_id: string | null;
    worker: string;
    fence: number;
    attempt_limit: number;
    head_oid: string | null;
    judged_oid: string | null;
    graph_revision: string | null;
    agents_json: string;
    expires_at: number;
    max_lifetime_at: number;
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
    assert.equal("heartbeatIntervalMs" in result, false);
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(result.node.state, "running");
    assert.equal(nodeState(fixture, fixtureIds.task), "running");
    assert.equal(nodeState(fixture, fixtureIds.objective), "running");
    assert.equal(nodeState(fixture, fixtureIds.initiative), "running");
  });

  it("a claim on an unassigned node writes node.assignment and inserts the run with the same worker id", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const rows = fixture.storage.transact((transaction) => ({
      node: transaction.get("SELECT assignment FROM node WHERE id = ?", [
        fixtureIds.task,
      ]) as Readonly<{ assignment: string | null }>,
      run: transaction.get(
        "SELECT worker FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ) as Readonly<{ worker: string }>,
    }));
    assert.equal(rows.node.assignment, "claude@1");
    assert.equal(rows.run.worker, "claude@1");
    assert.equal(rows.node.assignment, rows.run.worker);
  });

  it("a claim returns the run id and the fence", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT id, fence FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ id: string; fence: number }>;

    assert.equal(result.runId, run.id);
    assert.equal(result.fence, 1);
    assert.equal(result.fence, run.fence);
  });

  it("a claim opens the run with its provenance", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT worker, agents_json FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ worker: string; agents_json: string }>;

    assert.equal(run.worker, "claude@1");
    assert.equal(run.agents_json, JSON.stringify([]));
  });

  it("a claim writes expires_at and max_lifetime_at", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      runTtlMs: 120000,
      runMaxLifetimeMs: 900000,
    });

    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT expires_at, max_lifetime_at FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ expires_at: number; max_lifetime_at: number }>;

    assert.equal(run.expires_at, NOW + 120000);
    assert.equal(run.max_lifetime_at, NOW + 900000);
  });

  it("a claim records the project's newest plan revision, not the node's row revision", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const rows = fixture.storage.transact((transaction) => ({
      node: transaction.get("SELECT revision FROM node WHERE id = ?", [
        fixtureIds.task,
      ]) as Readonly<{ revision: string }>,
      run: transaction.get(
        "SELECT graph_revision FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ) as Readonly<{ graph_revision: string }>,
    }));

    assert.equal(rows.node.revision, REVISION_A);
    assert.equal(rows.run.graph_revision, "revision_b");
    assert.notEqual(rows.run.graph_revision, rows.node.revision);
  });

  it("a claim carrying no worker field still routes", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    const request = nodeClaimRequest.parse({ available: true });
    assert.deepEqual(Object.keys(request), ["available"]);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT worker FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ worker: string }>;
    assert.equal(run.worker, "claude@1");
  });

  it("the run kind comes from the node deliverable", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === fixtureIds.task ? { ...node, deliverable: "test" } : node,
      ),
    );

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT kind FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ kind: string }>;
    assert.equal(run.kind, "execution");
  });

  it("a review claim refuses review-head-unavailable and writes nothing", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === fixtureIds.task ? { ...node, deliverable: "review" } : node,
      ),
    );
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "review-head-unavailable");
    assert.deepEqual(error.details, {
      nodeId: fixtureIds.task,
      runKind: "review",
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("no command-created run carries a null judged_oid", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const reviewRuns = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM run WHERE kind = 'review'"),
    ) as Readonly<{ c: number }>;
    assert.equal(reviewRuns.c, 0);
  });

  it("a claim writes no run_base row", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const runBases = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM run_base"),
    ) as Readonly<{ c: number }>;
    assert.equal(runBases.c, 0);
  });

  it("a claim on an assigned node by a different worker refuses assignment-held, naming the current assignment", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "tdd@1",
      });
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      callerWorker: "general@1",
    });

    assert.equal(error.refusal, "assignment-held");
    assert.deepEqual(error.details, {
      assignment: "tdd@1",
      claimant: "general@1",
      maySwitch: true,
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim on a node assigned to the claiming worker succeeds", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "claude@1",
      });
    });

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const run = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT worker, fence FROM run WHERE node_id = ? AND state = 'active'",
        [fixtureIds.task],
      ),
    ) as Readonly<{ worker: string; fence: number }>;

    assert.equal(result.fence, 1);
    assert.equal(run.worker, "claude@1");
    assert.equal(run.fence, result.fence);
    assert.equal(nodeState(fixture, fixtureIds.task), "running");
  });

  it("a caller authorized for a worker outside the capable set refuses unroutable rather than throwing", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      callerWorker: "claude@1",
      authorizedWorkers: ["general@1"],
    });

    assert.equal(error.refusal, "unroutable");
    assert.deepEqual(error.details, { failedSet: "authorized" });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim carrying available false refuses unroutable with failedSet available and writes no run row", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      available: false,
    });

    assert.equal(error.refusal, "unroutable");
    assert.deepEqual(error.details, { failedSet: "available" });
    const runs = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM run"),
    ) as Readonly<{ c: number }>;
    assert.equal(runs.c, 0);
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("an illegal pair refuses pair-illegal", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const readAllNodes = fixture.plan.plan.readAllNodes;
    fixture.plan.plan.readAllNodes = (transaction) =>
      readAllNodes(transaction).map((node) =>
        node.id === fixtureIds.task
          ? { ...node, deliverable: "expansion" }
          : node,
      );

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "pair-illegal");
    assert.deepEqual(error.details, {
      kind: "task",
      deliverable: "expansion",
    });
  });

  it("a claim failing both pair-illegal and assignment-held reports pair-illegal", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "tdd@1",
      });
    });
    const readAllNodes = fixture.plan.plan.readAllNodes;
    fixture.plan.plan.readAllNodes = (transaction) =>
      readAllNodes(transaction).map((node) =>
        node.id === fixtureIds.task
          ? { ...node, deliverable: "expansion" }
          : node,
      );
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      callerWorker: "general@1",
    });

    assert.equal(error.refusal, "pair-illegal");
    assert.deepEqual(error.details, {
      kind: "task",
      deliverable: "expansion",
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim failing both node-not-found and every later condition reports node-not-found", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "tdd@1",
      });
      fixture.execution.execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "structural",
        workspaceId: null,
        attemptLimit: ATTEMPT_LIMIT,
        worker: "tdd@1",
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW + TTL,
        maxLifetimeAt: NOW + TTL,
      });
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 'actor', 1, ?, ?, ?)",
        [fixtureIds.task, ACTOR_B, NOW, NOW, NOW + TTL],
      );
    });
    const readAllNodes = fixture.plan.plan.readAllNodes;
    fixture.plan.plan.readAllNodes = (transaction) =>
      readAllNodes(transaction).filter((node) => node.id !== fixtureIds.task);
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "node-not-found");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("every refusal leaves the database byte-identical", (t) => {
    const cases: readonly Readonly<{
      refusal: string;
      prepare(fixture: ClaimFixture): void;
      input: ClaimInput;
    }>[] = [
      {
        refusal: "node-not-found",
        prepare: seedReadyFixture,
        input: { nodeId: "node_does_not_exist", actorId: ACTOR_A },
      },
      {
        refusal: "pair-illegal",
        prepare(fixture) {
          seedReadyFixture(fixture);
          const readAllNodes = fixture.plan.plan.readAllNodes;
          fixture.plan.plan.readAllNodes = (transaction) =>
            readAllNodes(transaction).map((node) =>
              node.id === fixtureIds.task
                ? { ...node, deliverable: "expansion" }
                : node,
            );
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
      {
        refusal: "plan-incomplete",
        prepare(fixture) {
          seedReadyFixture(fixture);
          const readAllNodes = fixture.plan.plan.readAllNodes;
          fixture.plan.plan.readAllNodes = (transaction) =>
            readAllNodes(transaction)
              .filter((node) => node.id !== fixtureIds.task)
              .map((node) =>
                node.id === fixtureIds.objective
                  ? { ...node, deliverable: "implementation" }
                  : node,
              );
        },
        input: { nodeId: fixtureIds.objective, actorId: ACTOR_A },
      },
      {
        refusal: "assignment-held",
        prepare(fixture) {
          seedReadyFixture(fixture);
          fixture.storage.transact((transaction) => {
            fixture.plan.plan.setNodeAssignment(transaction, {
              id: fixtureIds.task,
              assignment: "tdd@1",
            });
          });
        },
        input: {
          nodeId: fixtureIds.task,
          actorId: ACTOR_A,
          callerWorker: "general@1",
        },
      },
      {
        refusal: "unroutable",
        prepare: seedReadyFixture,
        input: {
          nodeId: fixtureIds.task,
          actorId: ACTOR_A,
          available: false,
        },
      },
      {
        refusal: "review-head-unavailable",
        prepare(fixture) {
          seedReadyFixture(fixture);
          projectClaimNodes(fixture, (nodes) =>
            nodes.map((node) =>
              node.id === fixtureIds.task
                ? { ...node, deliverable: "review" }
                : node,
            ),
          );
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
      {
        refusal: "lease-held",
        prepare(fixture) {
          seedReadyFixture(fixture);
          seedTaskLease(fixture);
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_B },
      },
      {
        refusal: "drive-mode-pinned",
        prepare(fixture) {
          seedReadyFixture(fixture);
          fixture.storage.transact((transaction) => {
            seedWorkspaceOnNode(transaction, {
              id: "workspace_a",
              nodeId: fixtureIds.objective,
            });
            transaction.run(
              "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'structural', ?, 'internal', ?, ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'ended', 'completed', ?)",
              [
                "run_internal",
                fixtureIds.objective,
                "workspace_a",
                "claude@1",
                1,
                ATTEMPT_LIMIT,
                REVISION_A,
                NOW + TTL,
                NOW + TTL,
                NOW - 1,
              ],
            );
          });
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
      {
        refusal: "subtree-busy",
        prepare(fixture) {
          seedReadyFixture(fixture);
          fixture.storage.transact((transaction) => {
            transaction.run(
              "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'structural', ?, 'external', NULL, ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'active', NULL, NULL)",
              [
                "run_ancestor",
                fixtureIds.objective,
                "claude@1",
                1,
                ATTEMPT_LIMIT,
                REVISION_A,
                NOW + TTL,
                NOW + TTL,
              ],
            );
          });
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
      {
        refusal: "illegal-transition",
        prepare(fixture) {
          seedReadyFixture(fixture);
          fixture.storage.transact((transaction) =>
            seedNodeState(transaction, fixtureIds.task, "done"),
          );
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
      {
        refusal: "ancestor-not-startable",
        prepare(fixture) {
          seedReadyFixture(fixture);
          fixture.storage.transact((transaction) =>
            seedNodeState(transaction, fixtureIds.initiative, "done"),
          );
        },
        input: { nodeId: fixtureIds.task, actorId: ACTOR_A },
      },
    ];

    for (const refusalCase of cases) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      refusalCase.prepare(fixture);
      const before = databaseBytes(fixture.storage);
      const error = refused(
        fixture,
        createMockClock({ start: NOW }),
        refusalCase.input,
      );
      assert.equal(error.refusal, refusalCase.refusal);
      assert.deepEqual(
        databaseBytes(fixture.storage),
        before,
        refusalCase.refusal,
      );
    }
  });

  it("the refusal decision table names one winner per pair", (t) => {
    const pairs: Array<readonly [DecisionRefusal, DecisionRefusal]> = [];
    for (let left = 0; left < CLAIM_REFUSAL_ORDER.length; left++) {
      for (let right = left + 1; right < CLAIM_REFUSAL_ORDER.length; right++) {
        pairs.push([CLAIM_REFUSAL_ORDER[left]!, CLAIM_REFUSAL_ORDER[right]!]);
      }
    }

    assert.equal(pairs.length, 55);
    assert.equal(
      new Set(pairs.map(([left, right]) => `${left}|${right}`)).size,
      55,
    );

    for (const pair of pairs) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      const input = prepareDecisionPair(fixture, pair);
      const error = refused(fixture, createMockClock({ start: NOW }), input);
      const winner =
        CLAIM_REFUSAL_ORDER.indexOf(pair[0]) <
        CLAIM_REFUSAL_ORDER.indexOf(pair[1])
          ? pair[0]
          : pair[1];
      assert.equal(error.refusal, winner, `${pair[0]}|${pair[1]}`);
    }
  });

  it("a task claim opens exactly one run", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const runs = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT node_id FROM run WHERE state = 'active' ORDER BY id",
      ),
    ) as readonly Readonly<{ node_id: string }>[];
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.node_id, fixtureIds.task);
  });

  it("run-driver-mismatch is not a member of ClaimRefusal", () => {
    assert.equal(
      (claimRefusalCodes as readonly string[]).includes("run-driver-mismatch"),
      false,
    );
  });

  it("initiative-not-claimable is not a member of ClaimRefusal", () => {
    assert.equal(
      (claimRefusalCodes as readonly string[]).includes(
        "initiative-not-claimable",
      ),
      false,
    );
  });

  it("a claim on a descendant of a node holding an active run refuses subtree-busy, naming the ancestor", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'structural', ?, 'external', NULL, ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'active', NULL, NULL)",
        [
          "run_ancestor",
          fixtureIds.objective,
          "claude@1",
          1,
          ATTEMPT_LIMIT,
          REVISION_A,
          NOW + TTL,
          NOW + TTL,
        ],
      );
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "subtree-busy");
    assert.deepEqual(error.details, {
      relation: "ancestor",
      nodeId: fixtureIds.objective,
      runId: "run_ancestor",
      expiresAt: NOW + TTL,
    });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a second claim by the same worker refuses subtree-busy with relation self", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    const first = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "subtree-busy");
    assert.deepEqual(error.details, {
      relation: "self",
      nodeId: fixtureIds.task,
      runId: first.runId,
      expiresAt: NOW + 120000,
    });
  });

  it("the run_one_active index refuses a second active run on the same node against real SQLite", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.throws(
      () =>
        fixture.storage.transact((transaction) => {
          fixture.execution.execution.openRun(transaction, {
            nodeId: fixtureIds.task,
            kind: "execution",
            workspaceId: null,
            attemptLimit: ATTEMPT_LIMIT,
            worker: "claude@1",
            fence: 1,
            judgedOid: null,
            graphRevision: REVISION_A,
            agents: [],
            expiresAt: NOW + TTL,
            maxLifetimeAt: NOW + TTL,
          });
        }),
      /UNIQUE constraint failed/,
    );
  });

  it("an expired run in the exclusion input does not refuse a claim", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "structural",
        workspaceId: null,
        attemptLimit: ATTEMPT_LIMIT,
        worker: "claude@1",
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW - 1,
        maxLifetimeAt: NOW + TTL,
      });
    });

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const ancestorRun = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT state, fence, outcome, ended_at FROM run WHERE node_id = ?",
        [fixtureIds.objective],
      ),
    ) as Readonly<{
      state: string;
      fence: number;
      outcome: string | null;
      ended_at: number | null;
    }>;
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(ancestorRun.state, "ended");
    assert.equal(ancestorRun.fence, 2);
    assert.equal(ancestorRun.outcome, "expired");
    assert.equal(ancestorRun.ended_at, NOW);
  });

  it("node.assignment is unchanged after an expiry and after an unroutable claim on a different node", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "claude@1",
      });
      fixture.execution.execution.openRun(transaction, {
        nodeId: fixtureIds.task,
        kind: "execution",
        workspaceId: null,
        attemptLimit: ATTEMPT_LIMIT,
        worker: "claude@1",
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW - 1,
        maxLifetimeAt: NOW + TTL,
      });
    });
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === TASK_B ? { ...node, deliverable: "implementation" } : node,
      ),
    );

    fixture.storage.transact((transaction) =>
      expireRuns(
        {
          events: fixture.events,
          execution: fixture.execution.execution,
          instanceId: INSTANCE,
        },
        transaction,
        { now: NOW },
      ),
    );

    const assignmentAfterExpiry = fixture.storage.transact(
      (transaction) =>
        transaction.get("SELECT assignment FROM node WHERE id = ?", [
          fixtureIds.task,
        ]) as Readonly<{ assignment: string | null }>,
    );
    assert.equal(assignmentAfterExpiry.assignment, "claude@1");

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: TASK_B,
      actorId: ACTOR_A,
      available: false,
    });
    assert.equal(error.refusal, "unroutable");

    const assignmentAfterRefusal = fixture.storage.transact(
      (transaction) =>
        transaction.get("SELECT assignment FROM node WHERE id = ?", [
          fixtureIds.task,
        ]) as Readonly<{ assignment: string | null }>,
    );
    assert.equal(assignmentAfterRefusal.assignment, "claude@1");
  });

  it("an expired run and a refused claim leave the database unchanged", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.plan.plan.setNodeAssignment(transaction, {
        id: fixtureIds.task,
        assignment: "tdd@1",
      });
      fixture.execution.execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "structural",
        workspaceId: null,
        attemptLimit: ATTEMPT_LIMIT,
        worker: "claude@1",
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW - 1,
        maxLifetimeAt: NOW + TTL,
      });
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
      callerWorker: "general@1",
    });

    assert.equal(error.refusal, "assignment-held");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a task whose worker is opencode.te@1 is claimed identically to a task whose worker is general@1", (t) => {
    const fixtureA = createClaimFixture();
    t.after(() => fixtureA.dispose());
    seedReadyFixture(fixtureA);
    fixtureA.storage.transact((transaction) =>
      seedNodeWorker(transaction, fixtureIds.task, "general@1"),
    );

    const fixtureB = createClaimFixture();
    t.after(() => fixtureB.dispose());
    seedReadyFixture(fixtureB);
    fixtureB.storage.transact((transaction) =>
      seedNodeWorker(transaction, fixtureIds.task, "opencode.te@1"),
    );

    const clock = createMockClock({ start: NOW });
    const resultA = claim(fixtureA, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const resultB = claim(fixtureB, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.deepEqual(resultB.lease, resultA.lease);
    assert.deepEqual(resultB.objectiveLease, resultA.objectiveLease);
    assert.equal(resultB.node.state, resultA.node.state);
    assert.equal(resultB.attemptNo, resultA.attemptNo);
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

  it("a claim on an initiative whose deliverable is expansion succeeds", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });
    const run = fixture.storage.transact((transaction) =>
      transaction.get("SELECT id, kind FROM run WHERE id = ?", [result.runId]),
    ) as Readonly<{ id: string; kind: string }>;

    assert.equal(result.runId, run.id);
    assert.equal(run.kind, "structural");
  });

  it("a claim on an initiative refuses unroutable with failedSet capable against the production registry", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "unroutable");
    assert.deepEqual(error.details, { failedSet: "capable" });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim on an objective carrying expansion refuses unroutable with failedSet capable, like an initiative", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const readAllNodes = fixture.plan.plan.readAllNodes;
    fixture.plan.plan.readAllNodes = (transaction) =>
      readAllNodes(transaction).map((node) =>
        node.id === fixtureIds.objective
          ? { ...node, deliverable: "expansion" }
          : node,
      );
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.objective,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "unroutable");
    assert.deepEqual(error.details, { failedSet: "capable" });
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("a claim on a task whose sibling task holds an active run refuses objective-busy, naming the sibling, its run and its expires_at", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'execution', ?, 'external', NULL, ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'active', NULL, NULL)",
        [
          "run_sibling",
          TASK_B,
          "general@1",
          3,
          ATTEMPT_LIMIT,
          REVISION_A,
          NOW + TTL,
          NOW + TTL,
        ],
      );
    });

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "objective-busy");
    assert.deepEqual(error.details, {
      objectiveId: fixtureIds.objective,
      siblingNodeId: TASK_B,
      siblingRunId: "run_sibling",
      expiresAt: NOW + TTL,
    });
  });

  it("a sibling task with an ended run admits the claim", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    fixture.storage.transact((transaction) => {
      const siblingRun = fixture.execution.execution.openRun(transaction, {
        nodeId: TASK_B,
        kind: "execution",
        workspaceId: null,
        worker: "general@1",
        attemptLimit: ATTEMPT_LIMIT,
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW + TTL,
        maxLifetimeAt: NOW + TTL,
      });
      fixture.execution.execution.endRun(transaction, {
        runId: siblingRun.id,
        outcome: "completed",
        at: NOW - 1,
      });
    });

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(result.node.id, fixtureIds.task);
  });

  it("a sibling task with an expired run admits the claim", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.openRun(transaction, {
        nodeId: TASK_B,
        kind: "execution",
        workspaceId: null,
        worker: "general@1",
        attemptLimit: ATTEMPT_LIMIT,
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW - 1,
        maxLifetimeAt: NOW + TTL,
      });
    });

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    const siblingRun = fixture.storage.transact((transaction) =>
      transaction.get("SELECT state, fence FROM run WHERE node_id = ?", [
        TASK_B,
      ]),
    ) as Readonly<{ state: string; fence: number }>;
    assert.equal(result.node.id, fixtureIds.task);
    assert.equal(siblingRun.state, "ended");
    assert.equal(siblingRun.fence, 2);
  });

  it("an objective-busy refusal leaves the database byte-identical", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, 'execution', ?, 'external', NULL, ?, ?, ?, NULL, NULL, ?, '[]', ?, ?, 'active', NULL, NULL)",
        [
          "run_sibling",
          TASK_B,
          "general@1",
          3,
          ATTEMPT_LIMIT,
          REVISION_A,
          NOW + TTL,
          NOW + TTL,
        ],
      );
    });
    const before = databaseBytes(fixture.storage);

    const error = refused(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });

    assert.equal(error.refusal, "objective-busy");
    assert.deepEqual(databaseBytes(fixture.storage), before);
  });

  it("the decision table gains one row per refusal that can trigger beside objective-busy", (t) => {
    const objectivePairs = OBJECTIVE_BUSY_COMPANIONS.map(
      (companion) => [companion, "objective-busy"] as const,
    );
    const basePairs: Array<readonly [DecisionRefusal, DecisionRefusal]> = [];
    for (let left = 0; left < CLAIM_REFUSAL_ORDER.length; left++) {
      for (let right = left + 1; right < CLAIM_REFUSAL_ORDER.length; right++) {
        basePairs.push([
          CLAIM_REFUSAL_ORDER[left]!,
          CLAIM_REFUSAL_ORDER[right]!,
        ]);
      }
    }
    const extendedPairs = [...basePairs, ...objectivePairs];
    const pairKeys = extendedPairs.map(([left, right]) => `${left}|${right}`);

    assert.equal(objectivePairs.length, 7);
    assert.equal(extendedPairs.length, 62);
    assert.equal(new Set(pairKeys).size, extendedPairs.length);

    for (const [companion, objective] of objectivePairs) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      const input = prepareObjectiveBusyPair(fixture, companion);
      const error = refused(fixture, createMockClock({ start: NOW }), input);
      const winner =
        EXTENDED_CLAIM_REFUSAL_ORDER.indexOf(companion) <
        EXTENDED_CLAIM_REFUSAL_ORDER.indexOf(objective)
          ? companion
          : objective;
      assert.equal(error.refusal, winner, `${companion}|${objective}`);
    }
  });

  it("an initiative claim evaluates no objective-busy", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedSecondProjectFixture(fixture);
    fixture.storage.transact((transaction) => {
      fixture.execution.execution.openRun(transaction, {
        nodeId: "task_pb",
        kind: "execution",
        workspaceId: null,
        worker: "general@1",
        attemptLimit: ATTEMPT_LIMIT,
        fence: 1,
        judgedOid: null,
        graphRevision: REVISION_A,
        agents: [],
        expiresAt: NOW + TTL,
        maxLifetimeAt: NOW + TTL,
      });
    });

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });

    assert.equal(result.node.id, fixtureIds.initiative);
  });

  it("a structural run opens no attempt", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });

    const count = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM attempt"),
    ) as Readonly<{ c: number }>;
    assert.equal(count.c, 0);
  });

  it("a structural run writes no run_base row", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });

    const count = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS c FROM run_base"),
    ) as Readonly<{ c: number }>;
    assert.equal(count.c, 0);
  });

  it("an initiative claim appends exactly two events", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });

    assert.deepEqual(
      fixture.events.list({}).map((event) => event.type),
      ["run.opened", "node.running"],
    );
  });

  it("an initiative claim writes the assignment", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);

    const result = claim(fixture, createMockClock({ start: NOW }), {
      nodeId: fixtureIds.initiative,
      registry: expansionCapableRegistry,
      actorId: ACTOR_A,
    });
    const rows = fixture.storage.transact((transaction) => ({
      node: transaction.get("SELECT assignment FROM node WHERE id = ?", [
        fixtureIds.initiative,
      ]) as Readonly<{ assignment: string | null }>,
      run: transaction.get("SELECT worker FROM run WHERE id = ?", [
        result.runId,
      ]) as Readonly<{ worker: string }>,
    }));

    assert.equal(rows.node.assignment, rows.run.worker);
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
    projectClaimNodes(fixture, (nodes) =>
      nodes.map((node) =>
        node.id === EMPTY_OBJECTIVE
          ? { ...node, deliverable: "implementation" }
          : node,
      ),
    );
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
  });

  it("a claim on a task in each non-ready task state is refused illegal-transition", (t) => {
    for (const state of ["pending", "blocked", "done", "discarded"] as const) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        seedNodeState(transaction, fixtureIds.initiative, "ready");
        seedNodeState(transaction, fixtureIds.task, state);
        seedNodeState(transaction, fixtureIds.objective, "ready");
      });
      const before = databaseBytes(fixture.storage);
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
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

  it("the state branch refuses each non-ready task state", (t) => {
    for (const state of ["pending", "blocked", "done", "discarded"] as const) {
      const fixture = createClaimFixture();
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedGraph(transaction);
        seedNodeState(transaction, fixtureIds.initiative, "ready");
        seedNodeState(transaction, fixtureIds.task, state);
        seedNodeState(transaction, fixtureIds.objective, "ready");
      });
      const error = refused(fixture, createMockClock({ start: NOW }), {
        nodeId: fixtureIds.task,
        actorId: ACTOR_A,
      });
      assert.equal(error.refusal, "illegal-transition");
      assert.deepEqual(error.details, {
        state,
        admitted: ["ready", "running"],
      });
    }
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
    assert.equal(events[events.length - 2]!.actorId, ACTOR_B);
    assert.equal(events[events.length - 1]!.type, "node.running");
  });

  it("a same-worker claim on a busy sibling is refused objective-busy", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadySiblingFixture(fixture);
    const clock = createMockClock({ start: NOW });
    const first = claim(fixture, clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    const error = refused(fixture, clock, {
      nodeId: TASK_B,
      actorId: ACTOR_A,
    });
    assert.equal(error.refusal, "objective-busy");
    assert.deepEqual(error.details, {
      objectiveId: fixtureIds.objective,
      siblingNodeId: fixtureIds.task,
      siblingRunId: first.runId,
      expiresAt: NOW + 120000,
    });
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

  it("an expired lease does not bypass an active run", (t) => {
    const fixture = createClaimFixture();
    t.after(() => fixture.dispose());
    seedReadyFixture(fixture);
    const mutable = createMutableClock();
    claim(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_A,
    });
    mutable.advance(TTL + 1);
    const error = refused(fixture, mutable.clock, {
      nodeId: fixtureIds.task,
      actorId: ACTOR_B,
    });
    assert.equal(error.refusal, "illegal-transition");
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
          kind: "structural",
          nodeId: fixtureIds.objective,
          workspaceId: null,
          worker: "claude@1",
          attemptLimit: ATTEMPT_LIMIT,
          fence: 1,
          judgedOid: null,
          graphRevision: REVISION_A,
          agents: [],
          expiresAt: NOW + TTL,
          maxLifetimeAt: NOW + TTL,
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
});
