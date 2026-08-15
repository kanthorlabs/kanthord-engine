import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deleteNode } from "./delete-node.ts";
import type { DeleteNodeInput, DeleteNodeResult } from "./delete-node.ts";
import { NodeWriteError } from "./refusal.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import type { ActorRow } from "../../domain/actor.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import { exportPlan } from "../../queries/plan/export-plan.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRecordingPlanStore,
  createRevision,
  nodeBaselineRevision,
  planFixtureBodies,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import type { RecordedPlanCall } from "../../../test/helpers/plan.ts";
import {
  createMigratedStorage,
  databaseBytes,
  tableCounts,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedAttemptRow,
  seedCandidateRow,
  seedCheckResultRow,
  seedGitOperationRow,
  seedLeaseOnNode,
  seedNodeState,
  seedRegistry,
  seedReleasedLeaseOnNode,
  seedRunRow,
  seedWaivedEdge,
  seedWorkspaceOnNode,
} from "../../../test/helpers/rows.ts";

const encoder = new TextEncoder();

const CLOCK_START = 1700000000000;

const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";

const taskId = planFixtureIdentities.task;
const objectiveId = planFixtureIdentities.objective;
const initiativeId = planFixtureIdentities.initiative;
const taskTwoId = planFixtureIdentities.taskTwo;
const objectiveTwoId = "objective_01FRZ3NDEKTSV4RRFFQ69G5FAW";
const taskThreeId = "task_01HRZ3NDEKTSV4RRFFQ69G5FAY";

const HARNESS_ACTOR: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: "actor_00000000000000000000000000",
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function createRecordingEventLog(): Readonly<{
  events: EventLog;
  recorded: readonly RecordedAppend[];
}> {
  const recorded: RecordedAppend[] = [];
  return {
    recorded,
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        recorded.push({ transaction, input });
        return {
          id: "event_1",
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
        return [];
      },
    },
  };
}

type DeleteFixture = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  revision: Revision;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  recorded: readonly RecordedAppend[];
  calls: readonly RecordedPlanCall[];
  dispose(): void;
}>;

function build(
  seed: (storage: Storage, plan: PlanStore, blobs: BlobStore) => void,
  ulids: readonly string[],
): DeleteFixture {
  const temporary = createMigratedStorage();
  const log = createRecordingEventLog();
  const rawPlan = createPlanStore(createReadiness(log.events, "daemon_test"));
  const blobs = createBlobStore(
    temporary.storage,
    createMockClock({ start: CLOCK_START, step: 1000 }),
  );
  seed(temporary.storage, rawPlan, blobs);
  reseedBaselineRevision(temporary.storage);
  const recording = createRecordingPlanStore(rawPlan);
  return {
    storage: temporary.storage,
    plan: recording.plan,
    blobs,
    revision: createRevision(blobs, recording.plan),
    graph: createPlanGraph(),
    ids: createMockIdGenerator({ ulids }),
    clock: createMockClock({ start: CLOCK_START, step: 1000 }),
    events: log.events,
    recorded: log.recorded,
    calls: recording.calls,
    dispose: temporary.dispose,
  };
}

function seedTask(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  id: string,
): void {
  seedTaskUnder(storage, plan, blobs, id, planFixtureIdentities.objective);
}

function seedTaskUnder(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  id: string,
  parentId: string,
): void {
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id,
          projectId: fixtureIds.project,
          kind: "task",
          parentId,
          title: "Sibling task",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskInstruction),
          ),
          acceptanceBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskAcceptance),
          ),
          worker: null,
          repositoryId: null,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
      ],
      insertEdges: [],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function seedObjective(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  id: string,
): void {
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id,
          projectId: fixtureIds.project,
          kind: "objective",
          parentId: planFixtureIdentities.initiative,
          title: "Second objective",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.objective),
          ),
          acceptanceBlob: null,
          worker: null,
          repositoryId: fixtureIds.repository,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
      ],
      insertEdges: [],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function seedEdge(
  storage: Storage,
  plan: PlanStore,
  id: string,
  fromNode: string,
  toNode: string,
): void {
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [],
      insertEdges: [{ id, fromNode, toNode }],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function seedCustomTree(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
): void {
  storage.transact((transaction) => {
    seedRegistry(transaction);
    transaction.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
      [
        fixtureIds.planRevision,
        fixtureIds.project,
        null,
        "imp_a",
        fixtureIds.instructionBlob,
        fixtureIds.instructionBlob,
        fixtureIds.instructionBlob,
      ],
    );
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id: "initiative_zzzz",
          projectId: fixtureIds.project,
          kind: "initiative",
          parentId: null,
          title: "Zed initiative",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.initiative),
          ),
          acceptanceBlob: null,
          worker: null,
          repositoryId: null,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
        {
          id: "objective_aaaa",
          projectId: fixtureIds.project,
          kind: "objective",
          parentId: "initiative_zzzz",
          title: "Alpha objective",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.objective),
          ),
          acceptanceBlob: null,
          worker: null,
          repositoryId: fixtureIds.repository,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
        {
          id: "task_bbbb",
          projectId: fixtureIds.project,
          kind: "task",
          parentId: "objective_aaaa",
          title: "Bravo task",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskInstruction),
          ),
          acceptanceBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskAcceptance),
          ),
          worker: null,
          repositoryId: null,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
      ],
      insertEdges: [],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function seedRunOnTask(
  storage: Storage,
  plan: PlanStore,
  extra: (transaction: Transaction) => void = () => {},
): void {
  storage.transact((transaction) => {
    seedWorkspaceOnNode(transaction, {
      id: "workspace_1",
      nodeId: planFixtureIdentities.objective,
    });
    seedRunRow(transaction, {
      id: "run_1",
      kind: "objective",
      nodeId: planFixtureIdentities.objective,
      parentRunId: null,
      workspaceId: "workspace_1",
    });
    seedRunRow(transaction, {
      id: "run_2",
      kind: "task",
      nodeId: planFixtureIdentities.task,
      parentRunId: "run_1",
      workspaceId: "workspace_1",
    });
    extra(transaction);
  });
}

function runDelete(
  fixture: DeleteFixture,
  input: DeleteNodeInput,
): DeleteNodeResult {
  return deleteNode(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      blobs: fixture.blobs,
      graph: fixture.graph,
      ids: fixture.ids,
      clock: fixture.clock,
      events: fixture.events,
      revision: fixture.revision,
    },
    input,
  );
}

function deleteInput(id: string, fromRevision: string): DeleteNodeInput {
  return { id, fromRevision, actor: HARNESS_ACTOR };
}

function assertNoOrphanedLease(fixture: DeleteFixture): void {
  const orphans = fixture.storage.transact((transaction) =>
    transaction.all(
      "SELECT subject_id FROM lease WHERE subject_kind = 'node' AND subject_id NOT IN (SELECT id FROM node)",
    ),
  );
  assert.deepEqual(orphans, []);
}

function blockerRefusal(
  fixture: DeleteFixture,
  blocker: string,
  expected: readonly { nodeId: string; blocker: string }[],
): void {
  const before = databaseBytes(fixture.storage);
  let caught: unknown;
  try {
    runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof NodeWriteError,
    `expected a NodeWriteError, got ${String(caught)}`,
  );
  assert.equal(caught.refusal, "binding-in-use");
  const blockers = (
    caught.details as Readonly<{
      blockers: readonly Readonly<{ nodeId: string; blocker: string }>[];
    }>
  ).blockers;
  assert.ok(
    blockers.some((entry) => entry.blocker === blocker),
    `missing ${blocker} in ${JSON.stringify(blockers)}`,
  );
  if (expected.length > 0) {
    assert.deepEqual(blockers, expected);
  }
  assert.equal(Buffer.compare(databaseBytes(fixture.storage), before), 0);
}

describe("src/commands/node/delete-node.test", () => {
  it("deletes an objective and every task under it", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const before = tableCounts(fixture.storage);
    const result = runDelete(
      fixture,
      deleteInput(objectiveId, nodeBaselineRevision),
    );
    assert.match(result.revision, /^revision_/);
    assert.deepEqual(result.deleted, [objectiveId, taskId]);

    const remaining = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id FROM node WHERE id IN (?, ?)", [
        objectiveId,
        taskId,
      ]),
    );
    assert.deepEqual(remaining, []);
    const initiative = fixture.storage.transact((transaction) =>
      transaction.get("SELECT id FROM node WHERE id = ?", [initiativeId]),
    );
    assert.ok(initiative !== undefined);

    const after = tableCounts(fixture.storage);
    assert.equal(after.node, before.node - 2);
    assert.equal(after.plan_revision, before.plan_revision + 1);
    const row = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision WHERE id = ?",
        [result.revision],
      ),
    ) as
      | Readonly<{
          parent_id: string | null;
          origin: string;
          import_id: string | null;
          submitted_blob: string | null;
          choices_blob: string | null;
          accepted_blob: string;
        }>
      | undefined;
    assert.ok(row !== undefined);
    assert.equal(row.parent_id, nodeBaselineRevision);
    assert.equal(row.origin, "node-write");
    assert.equal(row.import_id, null);
    assert.equal(row.submitted_blob, null);
    assert.equal(row.choices_blob, null);
    assert.ok(row.accepted_blob.length > 0);

    assertNoOrphanedLease(fixture);
  });

  it("removes every edge touching the subtree", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedObjective(storage, plan, blobs, objectiveTwoId);
        seedTaskUnder(storage, plan, blobs, taskTwoId, objectiveTwoId);
        seedTaskUnder(storage, plan, blobs, taskThreeId, objectiveTwoId);
        seedEdge(storage, plan, "edge_fixture_del", taskTwoId, taskId);
        seedEdge(storage, plan, "edge_fixture_keep", taskThreeId, taskTwoId);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));

    const edges = fixture.storage.transact((transaction) =>
      transaction.all("SELECT from_node, to_node FROM edge ORDER BY id ASC"),
    ) as readonly Readonly<{ from_node: string; to_node: string }>[];
    assert.deepEqual(
      edges.map(({ from_node, to_node }) => ({ from_node, to_node })),
      [{ from_node: taskThreeId, to_node: taskTwoId }],
    );
    const nodes = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id FROM node"),
    ) as readonly Readonly<{ id: string }>[];
    const ids = new Set(nodes.map((row) => row.id));
    for (const edge of edges) {
      assert.ok(ids.has(edge.from_node), `from ${edge.from_node}`);
      assert.ok(ids.has(edge.to_node), `to ${edge.to_node}`);
    }
  });

  it("refuses a stale project revision", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const before = tableCounts(fixture.storage);
    let caught: unknown;
    try {
      runDelete(fixture, deleteInput(taskId, "revision_stale"));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "stale-revision");
    assert.deepEqual(caught.details, {
      guard: "project",
      expected: nodeBaselineRevision,
      actual: "revision_stale",
    });
    const after = tableCounts(fixture.storage);
    assert.equal(after.node, before.node);
    assert.equal(after.edge, before.edge);
    assert.equal(after.plan_revision, before.plan_revision);
  });

  it("refuses a subtree node in a non-deletable state", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedNodeState(transaction, taskId, "done");
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    let caught: unknown;
    try {
      runDelete(fixture, deleteInput(objectiveId, nodeBaselineRevision));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "illegal-transition");
    assert.deepEqual(caught.details, {
      nodes: [{ id: taskId, state: "done" }],
    });
  });

  it("a lease blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedLeaseOnNode(transaction, taskId);
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "lease", [{ nodeId: taskId, blocker: "lease" }]);
  });

  it("a workspace blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedWorkspaceOnNode(transaction, {
            id: "workspace_1",
            nodeId: taskId,
          });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "workspace", [
      { nodeId: taskId, blocker: "workspace" },
    ]);
  });

  it("a run blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedRunOnTask(storage, plan);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "run", [{ nodeId: taskId, blocker: "run" }]);
  });

  it("an attempt blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedRunOnTask(storage, plan, (transaction) => {
          seedAttemptRow(transaction, { id: "attempt_1", runId: "run_2" });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "attempt", []);
  });

  it("a commit blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedRunOnTask(storage, plan, (transaction) => {
          seedCandidateRow(transaction, {
            id: "candidate_1",
            nodeId: taskId,
            runId: "run_2",
            workspaceId: "workspace_1",
          });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "commit", []);
  });

  it("a check-result blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedCheckResultRow(transaction, { id: "check_1", nodeId: taskId });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "check-result", [
      { nodeId: taskId, blocker: "check-result" },
    ]);
  });

  it("a git-operation blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedGitOperationRow(transaction, { id: "gitop_1", nodeId: taskId });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "git-operation", [
      { nodeId: taskId, blocker: "git-operation" },
    ]);
  });

  it("a run with an attempt reports both blockers", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedRunOnTask(storage, plan, (transaction) => {
          seedAttemptRow(transaction, { id: "attempt_1", runId: "run_2" });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    let caught: unknown;
    try {
      runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "binding-in-use");
    assert.deepEqual(caught.details, {
      blockers: [
        { nodeId: taskId, blocker: "run" },
        { nodeId: taskId, blocker: "attempt" },
      ],
    });
  });

  it("a waived edge refuses the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedWaivedEdge(transaction, {
            id: "edge_fixture_waived",
            fromNode: taskId,
            toNode: initiativeId,
            waivedAt: 100,
          });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    const before = tableCounts(fixture.storage);
    let caught: unknown;
    try {
      runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "binding-in-use");
    assert.deepEqual(caught.details, {
      blockers: [{ nodeId: taskId, blocker: "waived-edge" }],
    });
    const after = tableCounts(fixture.storage);
    assert.equal(after.plan_revision, before.plan_revision);
    const edge = fixture.storage.transact((transaction) =>
      transaction.get(
        "SELECT id, from_node, to_node, waived_at FROM edge WHERE id = ?",
        ["edge_fixture_waived"],
      ),
    ) as Readonly<{ id: string; waived_at: number }> | undefined;
    assert.equal(edge?.waived_at, 100);
  });

  it("the refusal order is state, then execution, then waiver", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedNodeState(transaction, taskId, "done");
          seedLeaseOnNode(transaction, taskId);
          seedWaivedEdge(transaction, {
            id: "edge_fixture_waived",
            fromNode: taskId,
            toNode: initiativeId,
            waivedAt: 100,
          });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    let caught: unknown;
    try {
      runDelete(fixture, deleteInput(objectiveId, nodeBaselineRevision));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "illegal-transition");
    assert.deepEqual(caught.details, {
      nodes: [{ id: taskId, state: "done" }],
    });
  });

  it("restamps only the survivors whose dependency set shrank", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedEdge(storage, plan, "edge_fixture_dep", taskTwoId, taskId);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    const before = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT id, revision, updated_at FROM node ORDER BY id ASC",
      ),
    ) as readonly Readonly<{
      id: string;
      revision: string;
      updated_at: number;
    }>[];

    const result = runDelete(
      fixture,
      deleteInput(taskId, nodeBaselineRevision),
    );
    assert.deepEqual(result.deleted, [taskId]);

    const after = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT id, revision, updated_at FROM node ORDER BY id ASC",
      ),
    ) as readonly Readonly<{
      id: string;
      revision: string;
      updated_at: number;
    }>[];
    const byId = new Map(after.map((row) => [row.id, row]));
    const beforeById = new Map(before.map((row) => [row.id, row]));
    assert.equal(byId.get(taskTwoId)?.revision, result.revision);
    assert.equal(byId.get(taskTwoId)?.updated_at, CLOCK_START);
    for (const row of before) {
      if (row.id === taskTwoId || row.id === taskId) {
        continue;
      }
      const now = byId.get(row.id);
      assert.ok(now !== undefined);
      assert.equal(now.revision, beforeById.get(row.id)?.revision);
      assert.equal(now.updated_at, beforeById.get(row.id)?.updated_at);
    }
  });

  it("deletes child-first", (t) => {
    const fixture = build(seedCustomTree, [U_REV]);
    t.after(() => fixture.dispose());

    const result = runDelete(
      fixture,
      deleteInput("initiative_zzzz", nodeBaselineRevision),
    );
    assert.deepEqual(result.deleted, [
      "initiative_zzzz",
      "objective_aaaa",
      "task_bbbb",
    ]);
    const input = fixture.calls[0]!.input as Readonly<{
      nodeDeletes: readonly string[];
    }>;
    assert.deepEqual(input.nodeDeletes, [
      "task_bbbb",
      "objective_aaaa",
      "initiative_zzzz",
    ]);

    assertNoOrphanedLease(fixture);
  });

  it("a released lease blocks the delete", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          seedReleasedLeaseOnNode(transaction, taskId);
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    blockerRefusal(fixture, "lease", [{ nodeId: taskId, blocker: "lease" }]);
  });

  it("one clock read per command", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedTask(storage, plan, blobs, taskThreeId);
        seedEdge(storage, plan, "edge_fixture_dep2", taskTwoId, taskId);
        seedEdge(storage, plan, "edge_fixture_dep3", taskThreeId, taskId);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));

    const rows = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id, updated_at FROM node ORDER BY id ASC"),
    ) as readonly Readonly<{ id: string; updated_at: number }>[];
    const byId = new Map(rows.map((row) => [row.id, row.updated_at]));
    assert.equal(byId.get(taskTwoId), CLOCK_START);
    assert.equal(byId.get(taskThreeId), CLOCK_START);
    assert.deepEqual(
      [...new Set(rows.map((row) => row.updated_at))].sort((a, b) => a - b),
      [1, CLOCK_START],
    );
  });

  it("promotes a dependent that loses its only dependency", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedEdge(storage, plan, "edge_fixture_dep", taskTwoId, taskId);
        storage.transact((transaction) => {
          seedNodeState(transaction, taskTwoId, "pending");
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    const appendedBefore = fixture.recorded.length;
    const result = runDelete(
      fixture,
      deleteInput(taskId, nodeBaselineRevision),
    );
    assert.match(result.revision, /^revision_/);

    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, taskTwoId),
    );
    assert.equal(stored?.state, "ready");
    assert.deepEqual(fixture.calls[0]!.transitions, [
      {
        nodeId: taskTwoId,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const appended = fixture.recorded.slice(appendedBefore);
    const readyEvents = appended.filter(
      (append) => append.input.type === "node.ready",
    );
    assert.equal(readyEvents.length, 1);
    assert.equal(readyEvents[0]!.input.subjectId, taskTwoId);
    assert.equal(readyEvents[0]!.input.actorKind, "daemon");
    assert.ok(
      fixture.calls.every((call) =>
        call.transitions.every(
          (transition) => transition.trigger !== "readiness-demoted",
        ),
      ),
    );

    assertNoOrphanedLease(fixture);
  });

  it("never demotes", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(objectiveId, nodeBaselineRevision));

    assert.deepEqual(fixture.calls[0]!.transitions, []);
  });

  it("reports completeness and refuses nothing", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const result = runDelete(
      fixture,
      deleteInput(taskId, nodeBaselineRevision),
    );
    assert.match(result.revision, /^revision_/);
    assert.deepEqual(
      result.completeness.map((finding) => finding.code),
      ["objective-without-task"],
    );
    const objective = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, objectiveId),
    );
    assert.equal(objective?.state, "ready");
    assert.equal(objective?.revision, nodeBaselineRevision);
    assert.equal(objective?.updatedAt, 1);
  });

  it("export bytes equal the accepted blob", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const result = runDelete(
      fixture,
      deleteInput(taskId, nodeBaselineRevision),
    );

    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        revision: fixture.revision,
      },
      { projectId: fixtureIds.project },
    );
    assert.equal(exported.revision, result.revision);
    const record = fixture.storage.transact((transaction) =>
      fixture.plan
        .listRevisions(transaction, fixtureIds.project)
        .find((entry) => entry.id === result.revision),
    );
    assert.ok(record !== undefined);
    const blob = fixture.blobs.get(record.acceptedBlob);
    assert.ok(blob !== null);
    const expected = encoder.encode(canonicalDocumentsJson(exported.documents));
    assert.equal(
      Buffer.compare(Buffer.from(expected), Buffer.from(blob.content)),
      0,
    );
  });

  it("appends one node.deleted event per deleted node in bytewise identity order, carrying the resolved actor", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(objectiveId, nodeBaselineRevision));

    const deleted = fixture.recorded.filter(
      (append) => append.input.type === "node.deleted",
    );
    assert.equal(deleted.length, 2);
    assert.deepEqual(
      deleted.map((append) => append.input.subjectId),
      [objectiveId, taskId],
    );
    for (const append of deleted) {
      assert.equal(append.input.subjectKind, "node");
      assert.equal(append.input.actorKind, "harness");
      assert.equal(append.input.actorId, HARNESS_ACTOR.id);
    }
  });

  it("calls mutateGraph exactly once and setNodeState never", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));

    assert.deepEqual(
      fixture.calls.map((call) => call.method),
      ["mutateGraph"],
    );
    assert.equal(
      Object.hasOwn(fixture.calls[0]!.input as object, "trigger"),
      false,
    );
  });

  it("every readiness transition on node.delete carries its matching trigger", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedEdge(storage, plan, "edge_fixture_dep", taskTwoId, taskId);
        storage.transact((transaction) => {
          seedNodeState(transaction, taskTwoId, "pending");
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    runDelete(fixture, deleteInput(taskId, nodeBaselineRevision));

    assertTriggersMatchTransitions(fixture.calls);
  });

  it("a mismatched trigger pair is refused by the store and writes nothing", (t) => {
    const fixture = build(seedPlanFixture, []);
    t.after(() => fixture.dispose());

    assertMismatchedTriggerRefused(fixture, taskId);
  });
});

function assertTriggersMatchTransitions(
  calls: readonly RecordedPlanCall[],
): void {
  assert.ok(calls.length > 0, "no mutation call was recorded");
  for (const call of calls) {
    for (const transition of call.transitions) {
      if (transition.from === "pending" && transition.to === "ready") {
        assert.equal(transition.trigger, "readiness-promoted");
      } else if (transition.from === "ready" && transition.to === "pending") {
        assert.equal(transition.trigger, "readiness-demoted");
      } else {
        assert.fail(
          `unexpected transition ${transition.from} -> ${transition.to}`,
        );
      }
    }
  }
}

function assertMismatchedTriggerRefused(
  fixture: DeleteFixture,
  nodeId: string,
): void {
  const before = fixture.storage.transact((transaction) =>
    fixture.plan.readNode(transaction, nodeId),
  );
  assert.ok(before !== null);
  assert.throws(
    () =>
      fixture.storage.transact((transaction) =>
        fixture.plan.setNodeState(transaction, {
          id: nodeId,
          from: "ready",
          to: "pending",
          trigger: "readiness-promoted",
          blockReason: null,
          at: 1,
          cause: { revision: nodeBaselineRevision, importId: null },
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "trigger readiness-promoted declares pending -> ready, the write names ready -> pending",
  );
  const after = fixture.storage.transact((transaction) =>
    fixture.plan.readNode(transaction, nodeId),
  );
  assert.deepEqual(after, before);
}
