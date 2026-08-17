import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { updateNode } from "./update-node.ts";
import type { UpdateNodeInput, UpdateNodeResult } from "./update-node.ts";
import { NodeWriteError } from "./refusal.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import type { ActorRow } from "../../domain/actor.ts";
import type { NodeState } from "../../domain/state.ts";
import { nodeStates } from "../../domain/state.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { MutateGraphInput } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import { exportPlan } from "../../queries/plan/export-plan.ts";
import { showNode } from "../../queries/node/show-node.ts";
import { importPlan } from "../../commands/plan/import-plan.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanReader,
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
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { tableCounts } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { createBackedExecutionFake } from "../../../test/helpers/execution.ts";
import {
  fixtureIds,
  seedLeaseOnNode,
  seedNodeState,
  seedRegistry,
  seedWaivedEdge,
  seedWorkspaceOnNode,
} from "../../../test/helpers/rows.ts";

const encoder = new TextEncoder();

const CLOCK_START = 1700000000000;

const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
const U_REV1 = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
const U_REV2 = "01ERZ3NDEKTSV4RRFFQ69G5FC4";
const U_REV3 = "01FQZ3NDEKTSV4RRFFQ69G5FC5";
const U_EDGE = "01JRZ3NDEKTSV4RRFFQ69G5FC6";
const U_EDGE1 = "01KRZ3NDEKTSV4RRFFQ69G5FC7";
const U_IMPORT_REV = "01LRZ3NDEKTSV4RRFFQ69G5FC8";

const taskId = planFixtureIdentities.task;
const objectiveId = planFixtureIdentities.objective;
const taskTwoId = planFixtureIdentities.taskTwo;
const objectiveTwoId = "objective_01FRZ3NDEKTSV4RRFFQ69G5FAW";
const initiativeTwoId = "initiative_01GRZ3NDEKTSV4RRFFQ69G5FAX";
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

type UpdateFixture = Readonly<{
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
): UpdateFixture {
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
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: planFixtureIdentities.objective,
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

function seedInitiative(
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
          kind: "initiative",
          parentId: null,
          title: "Second initiative",
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

function seedBoundRepository(storage: Storage, id: string, name: string): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        name,
        "https://example.invalid/r3.git",
        fixtureIds.provider,
        "repos/r3.git",
        "main",
        "main",
        "refs/heads/main",
        1,
        "ready",
        null,
        null,
        null,
        1,
      ],
    );
    transaction.run(
      "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
      [fixtureIds.project, "git", id, 1],
    );
  });
}

function runUpdate(
  fixture: UpdateFixture,
  input: UpdateNodeInput,
): UpdateNodeResult {
  return updateNode(
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

type TaskBody = Extract<UpdateNodeInput["node"], { kind: "task" }>;
type ObjectiveBody = Extract<UpdateNodeInput["node"], { kind: "objective" }>;

function taskBody(
  overrides: Readonly<{
    title?: string;
    parentId?: string;
    worker?: string | null;
    dependsOn?: readonly string[];
    instruction?: string;
    acceptance?: string;
  }> = {},
): TaskBody {
  return {
    kind: "task",
    title: "Harden the verify CLI",
    parentId: planFixtureIdentities.objective,
    instruction: planFixtureBodies.taskInstruction,
    acceptance: planFixtureBodies.taskAcceptance,
    worker: null,
    dependsOn: [],
    ...overrides,
  };
}

function objectiveBody(
  overrides: Readonly<{
    title?: string;
    parentId?: string;
    repo?: string;
    instruction?: string;
    worker?: string | null;
    dependsOn?: readonly string[];
  }> = {},
): ObjectiveBody {
  return {
    kind: "objective",
    title: "Harden the verify CLI",
    parentId: planFixtureIdentities.initiative,
    repo: "kanthord-verify",
    instruction: planFixtureBodies.objective,
    worker: null,
    dependsOn: [],
    ...overrides,
  };
}

function updateInput(
  id: string,
  fromRevision: string,
  node: UpdateNodeInput["node"],
): UpdateNodeInput {
  return {
    id,
    fromRevision,
    node,
    actor: HARNESS_ACTOR,
  };
}

function titleEdit(
  id: string,
  fromRevision: string,
  title: string,
): UpdateNodeInput {
  return updateInput(id, fromRevision, taskBody({ title }));
}

function structuralRefusal(
  fixture: UpdateFixture,
  input: UpdateNodeInput,
  code: string,
): void {
  const before = tableCounts(fixture.storage);
  let caught: unknown;
  try {
    runUpdate(fixture, input);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof NodeWriteError,
    `expected a NodeWriteError, got ${String(caught)}`,
  );
  assert.equal(caught.refusal, "plan-invalid");
  const findings = (
    caught.details as Readonly<{
      findings: readonly Readonly<{ code: string }>[];
    }>
  ).findings;
  assert.ok(
    findings.some((finding) => finding.code === code),
    `missing ${code} in ${JSON.stringify(findings)}`,
  );
  const after = tableCounts(fixture.storage);
  assert.equal(after.node, before.node);
  assert.equal(after.edge, before.edge);
  assert.equal(after.plan_revision, before.plan_revision);
}

function staleRefusal(
  fixture: UpdateFixture,
  input: UpdateNodeInput,
  guard: string,
  expected: string,
  actual: string,
): void {
  let caught: unknown;
  try {
    runUpdate(fixture, input);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof NodeWriteError);
  assert.equal(caught.refusal, "stale-revision");
  assert.deepEqual(caught.details, { guard, expected, actual });
}

describe("src/commands/node/update-node.test", () => {
  it("a title edit succeeds at every state", (t) => {
    for (const state of nodeStates) {
      const target =
        state === "awaiting_approval" || state === "partial"
          ? objectiveId
          : taskId;
      const fixture = build(
        (storage, plan, blobs) => {
          seedPlanFixture(storage, plan, blobs);
          if (target !== taskId) {
            seedObjective(storage, plan, blobs, objectiveTwoId);
          }
          storage.transact((transaction) => {
            seedNodeState(transaction, target, state);
          });
        },
        [U_REV],
      );
      t.after(() => fixture.dispose());

      const input =
        target === objectiveId
          ? updateInput(
              objectiveId,
              nodeBaselineRevision,
              objectiveBody({ title: "Renamed objective" }),
            )
          : titleEdit(taskId, nodeBaselineRevision, "Renamed task");
      const result = runUpdate(fixture, input);
      assert.match(result.revision, /^revision_/);
      assert.deepEqual(
        result.completeness.map((finding) => finding.code),
        target === objectiveId ? ["objective-without-task"] : [],
      );
      const stored = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, target),
      );
      assert.equal(stored?.state, state === "pending" ? "ready" : state);
    }
  });

  it("a structural edit succeeds at pending, ready and blocked and is illegal-transition at the other five", (t) => {
    for (const state of nodeStates) {
      const target =
        state === "awaiting_approval" || state === "partial"
          ? objectiveId
          : taskId;
      const fixture = build(
        (storage, plan, blobs) => {
          seedPlanFixture(storage, plan, blobs);
          seedTask(storage, plan, blobs, taskTwoId);
          if (target !== taskId) {
            seedObjective(storage, plan, blobs, objectiveTwoId);
          }
          storage.transact((transaction) => {
            seedNodeState(transaction, target, state);
          });
        },
        [U_REV, U_EDGE],
      );
      t.after(() => fixture.dispose());

      const input =
        target === objectiveId
          ? updateInput(
              objectiveId,
              nodeBaselineRevision,
              objectiveBody({ dependsOn: [objectiveTwoId] }),
            )
          : updateInput(
              taskId,
              nodeBaselineRevision,
              taskBody({ dependsOn: [taskTwoId] }),
            );
      if (state === "pending" || state === "ready" || state === "blocked") {
        const result = runUpdate(fixture, input);
        assert.match(result.revision, /^revision_/);
      } else {
        let caught: unknown;
        try {
          runUpdate(fixture, input);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught instanceof NodeWriteError);
        assert.equal(caught.refusal, "illegal-transition");
        assert.deepEqual(caught.details, {
          nodes: [{ id: target, state }],
        });
      }
    }
  });

  it("a field-only update at the node revision succeeds and the same request at the project revision is stale-revision", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV1, U_REV2],
    );
    t.after(() => fixture.dispose());

    const preamble = runUpdate(
      fixture,
      titleEdit(taskTwoId, nodeBaselineRevision, "Second task"),
    );
    assert.equal(preamble.revision, `revision_${U_REV1}`);

    const atNodeRevision = runUpdate(
      fixture,
      titleEdit(taskId, nodeBaselineRevision, "Renamed task"),
    );
    assert.equal(atNodeRevision.revision, `revision_${U_REV2}`);

    staleRefusal(
      fixture,
      titleEdit(taskId, preamble.revision, "Renamed again"),
      "node",
      atNodeRevision.revision,
      preamble.revision,
    );
  });

  it("a depends_on change at the node revision is stale-revision with guard project and succeeds at the project revision", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV1, U_REV2, U_EDGE],
    );
    t.after(() => fixture.dispose());

    const preamble = runUpdate(
      fixture,
      titleEdit(taskTwoId, nodeBaselineRevision, "Second task"),
    );
    assert.equal(preamble.revision, `revision_${U_REV1}`);

    staleRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
      "project",
      preamble.revision,
      nodeBaselineRevision,
    );

    const atProjectRevision = runUpdate(
      fixture,
      updateInput(
        taskId,
        preamble.revision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
    );
    assert.equal(atProjectRevision.revision, `revision_${U_REV2}`);
  });

  it("a parent change classifies as topology and a worker and a repo change as fields", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedObjective(storage, plan, blobs, objectiveTwoId);
        seedBoundRepository(storage, "repo_c", "bound-verify");
      },
      [U_REV1, U_REV2, U_REV3],
    );
    t.after(() => fixture.dispose());

    const preamble = runUpdate(
      fixture,
      titleEdit(taskTwoId, nodeBaselineRevision, "Second task"),
    );
    assert.equal(preamble.revision, `revision_${U_REV1}`);

    staleRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ parentId: objectiveTwoId }),
      ),
      "project",
      preamble.revision,
      nodeBaselineRevision,
    );

    const workerEdit = runUpdate(
      fixture,
      updateInput(taskId, nodeBaselineRevision, taskBody({ worker: "tdd@1" })),
    );
    assert.equal(workerEdit.revision, `revision_${U_REV2}`);

    const repoEdit = runUpdate(
      fixture,
      updateInput(
        objectiveId,
        nodeBaselineRevision,
        objectiveBody({ repo: "bound-verify" }),
      ),
    );
    assert.equal(repoEdit.revision, `revision_${U_REV3}`);
  });

  it("the concurrency proof: two field-only updates at their own node revisions make a linear chain", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV1, U_REV2],
    );
    t.after(() => fixture.dispose());

    const first = runUpdate(
      fixture,
      titleEdit(taskId, nodeBaselineRevision, "First title"),
    );
    const second = runUpdate(
      fixture,
      titleEdit(taskTwoId, nodeBaselineRevision, "Second title"),
    );

    const record = (id: string) =>
      fixture.storage.transact((transaction) =>
        fixture.plan
          .listRevisions(transaction, fixtureIds.project)
          .find((entry) => entry.id === id),
      );
    assert.equal(second.revision, `revision_${U_REV2}`);
    const secondRow = record(second.revision);
    assert.ok(secondRow !== undefined);
    assert.equal(secondRow.parentId, first.revision);

    const blob = fixture.blobs.get(secondRow.acceptedBlob);
    assert.ok(blob !== null);
    const text = new TextDecoder().decode(blob.content);
    assert.ok(text.includes("First title"));
    assert.ok(text.includes("Second title"));

    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        revision: fixture.revision,
      },
      { projectId: fixtureIds.project },
    );
    assert.equal(exported.revision, second.revision);
    const expected = encoder.encode(canonicalDocumentsJson(exported.documents));
    assert.equal(
      Buffer.compare(Buffer.from(expected), Buffer.from(blob.content)),
      0,
    );

    const nodes = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id, revision FROM node ORDER BY id ASC"),
    ) as readonly Readonly<{ id: string; revision: string }>[];
    const byId = new Map(nodes.map((row) => [row.id, row.revision]));
    assert.equal(byId.get(taskId), first.revision);
    assert.equal(byId.get(taskTwoId), second.revision);
  });

  it("refuses a parent-missing edit", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ parentId: planFixtureIdentities.initiative }),
      ),
      "parent-missing",
    );
  });

  it("refuses an unknown worker as worker-unknown", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ worker: "ghost@9" }),
      ),
      "worker-unknown",
    );
  });

  it("refuses an unknown repository as repository-unknown", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        objectiveId,
        nodeBaselineRevision,
        objectiveBody({ repo: "ghost-repo" }),
      ),
      "repository-unknown",
    );
  });

  it("refuses an unbound repository as repository-unbound", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          transaction.run(
            "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              "repo_b",
              "other-repo",
              "https://example.invalid/r2.git",
              fixtureIds.provider,
              "repos/r2.git",
              "main",
              "main",
              "refs/heads/main",
              1,
              "ready",
              null,
              null,
              null,
              1,
            ],
          );
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        objectiveId,
        nodeBaselineRevision,
        objectiveBody({ repo: "other-repo" }),
      ),
      "repository-unbound",
    );
  });

  it("refuses an absent dependency target as reference-unresolved", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: ["task_01ZZZ3NDEKTSV4RRFFQ69G5FAV"] }),
      ),
      "reference-unresolved",
    );
  });

  it("refuses a dependency across parents as dependency-cross-parent", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [planFixtureIdentities.initiative] }),
      ),
      "dependency-cross-parent",
    );
  });

  it("refuses a dependency on itself as dependency-self", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskId] }),
      ),
      "dependency-self",
    );
  });

  it("refuses a dependency cycle as dependency-cycle", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedEdge(storage, plan, "edge_fixture_cycle", taskId, taskTwoId);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      updateInput(
        taskTwoId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskId] }),
      ),
      "dependency-cycle",
    );
  });

  it("a parent move of a task holding a workspace is binding-in-use", (t) => {
    const fixture = build((storage, plan, blobs) => {
      seedPlanFixture(storage, plan, blobs);
      seedObjective(storage, plan, blobs, objectiveTwoId);
      storage.transact((transaction) => {
        seedWorkspaceOnNode(transaction, {
          id: "workspace_task",
          nodeId: taskId,
        });
      });
    }, []);
    t.after(() => fixture.dispose());

    let caught: unknown;
    try {
      runUpdate(
        fixture,
        updateInput(
          taskId,
          nodeBaselineRevision,
          taskBody({ parentId: objectiveTwoId }),
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "binding-in-use");
    assert.deepEqual(caught.details, {
      blockers: [{ nodeId: taskId, blocker: "workspace" }],
    });
  });

  it("an objective move uses the subtree facts", (t) => {
    const fixture = build((storage, plan, blobs) => {
      seedPlanFixture(storage, plan, blobs);
      seedInitiative(storage, plan, blobs, initiativeTwoId);
      storage.transact((transaction) => {
        seedLeaseOnNode(transaction, taskId);
      });
    }, []);
    t.after(() => fixture.dispose());

    let caught: unknown;
    try {
      runUpdate(
        fixture,
        updateInput(
          objectiveId,
          nodeBaselineRevision,
          objectiveBody({ parentId: initiativeTwoId }),
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "binding-in-use");
    assert.deepEqual(caught.details, {
      blockers: [{ nodeId: objectiveId, blocker: "lease" }],
    });
  });

  it("an empty differing-field set still mints a revision", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const before = tableCounts(fixture.storage);
    const result = runUpdate(
      fixture,
      updateInput(taskId, nodeBaselineRevision, taskBody()),
    );
    const after = tableCounts(fixture.storage);
    assert.equal(after.plan_revision, before.plan_revision + 1);
    assert.equal(result.revision, `revision_${U_REV}`);
    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, taskId),
    );
    assert.equal(stored?.revision, result.revision);
  });

  it("an update that empties an objective succeeds and reports the finding", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedObjective(storage, plan, blobs, objectiveTwoId);
      },
      [U_REV, U_IMPORT_REV],
    );
    t.after(() => fixture.dispose());

    const result = runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ parentId: objectiveTwoId }),
      ),
    );
    assert.match(result.revision, /^revision_/);
    assert.deepEqual(
      result.completeness.map((finding) => finding.code),
      ["objective-without-task"],
    );
    const objective = showNode(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        blobs: fixture.blobs,
        execution: createBackedExecutionFake({ ids: fixture.ids }).execution,
      },
      { id: objectiveId },
    );
    assert.equal(objective?.state, "ready");

    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        revision: fixture.revision,
      },
      { projectId: fixtureIds.project },
    );
    const reimport = importPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        blobs: fixture.blobs,
        reader: createPlanReader(),
        graph: fixture.graph,
        ids: fixture.ids,
        clock: fixture.clock,
        events: fixture.events,
      },
      {
        projectId: fixtureIds.project,
        fromRevision: exported.revision,
        importId: "imp_after_update",
        documents: exported.documents,
        choices: [
          planFixtureIdentities.initiative,
          objectiveId,
          objectiveTwoId,
          taskId,
        ].map((id) => ({ id, take: "database" })),
        validatedRevision: exported.revision,
        documentsHash: fixture.blobs.hash(
          encoder.encode(canonicalDocumentsJson(exported.documents)),
        ),
        actor: "human_1",
      },
    );
    assert.match(reimport.revision, /^revision_/);
    assert.deepEqual(
      reimport.completeness.map((finding) => finding.code),
      ["objective-without-task"],
    );
  });

  it("an update that adds an unsatisfied dependency to a ready node demotes it", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV, U_EDGE],
    );
    t.after(() => fixture.dispose());

    const appendedBefore = fixture.recorded.length;
    const result = runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
    );
    assert.equal(result.revision, `revision_${U_REV}`);

    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, taskId),
    );
    assert.equal(stored?.state, "pending");
    assert.deepEqual(fixture.calls[0]!.transitions, [
      {
        nodeId: taskId,
        from: "ready",
        to: "pending",
        trigger: "readiness-demoted",
      },
    ]);
    const appended = fixture.recorded.slice(appendedBefore);
    const pendingEvents = appended.filter(
      (append) => append.input.type === "node.pending",
    );
    assert.equal(pendingEvents.length, 1);
    assert.equal(pendingEvents[0]!.input.subjectId, taskId);
    assert.equal(pendingEvents[0]!.input.actorKind, "daemon");
  });

  it("an update that removes the same dependency promotes it back", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV1, U_EDGE, U_REV2],
    );
    t.after(() => fixture.dispose());

    runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
    );
    const appendedBefore = fixture.recorded.length;
    const result = runUpdate(
      fixture,
      updateInput(taskId, `revision_${U_REV1}`, taskBody()),
    );
    assert.equal(result.revision, `revision_${U_REV2}`);

    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, taskId),
    );
    assert.equal(stored?.state, "ready");
    assert.deepEqual(fixture.calls[1]!.transitions, [
      {
        nodeId: taskId,
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
    assert.equal(readyEvents[0]!.input.subjectId, taskId);
    assert.equal(readyEvents[0]!.input.actorKind, "daemon");
  });

  it("export bytes equal the accepted blob", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const result = runUpdate(
      fixture,
      titleEdit(taskId, nodeBaselineRevision, "Renamed task"),
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

  it("appends one node.updated event whose payload lists the differing fields", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    const result = runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ title: "Renamed task", worker: "tdd@1" }),
      ),
    );

    const updated = fixture.recorded.filter(
      (append) => append.input.type === "node.updated",
    );
    assert.equal(updated.length, 1);
    assert.equal(updated[0]!.input.subjectKind, "node");
    assert.equal(updated[0]!.input.subjectId, taskId);
    assert.equal(updated[0]!.input.actorKind, "harness");
    assert.equal(updated[0]!.input.actorId, HARNESS_ACTOR.id);
    assert.deepEqual(updated[0]!.input.payload, {
      fields: ["title", "worker"],
      revision: result.revision,
    });
  });

  it("calls mutateGraph exactly once and setNodeState never", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    runUpdate(fixture, titleEdit(taskId, nodeBaselineRevision, "Renamed task"));

    assert.deepEqual(
      fixture.calls.map((call) => call.method),
      ["mutateGraph"],
    );
    assert.equal(
      Object.hasOwn(fixture.calls[0]!.input as object, "trigger"),
      false,
    );
  });

  it("edge reconciliation deletes before it inserts", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        seedTask(storage, plan, blobs, taskThreeId);
        seedEdge(storage, plan, "edge_fixture_swap", taskId, taskTwoId);
      },
      [U_REV, U_EDGE1],
    );
    t.after(() => fixture.dispose());

    runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskThreeId] }),
      ),
    );

    const input = fixture.calls[0]!.input as Readonly<{
      deleteEdgeIds: readonly string[];
      insertEdges: readonly Readonly<{
        id: string;
        fromNode: string;
        toNode: string;
      }>[];
    }>;
    assert.deepEqual(input.deleteEdgeIds, ["edge_fixture_swap"]);
    assert.deepEqual(input.insertEdges, [
      {
        id: `edge_${U_EDGE1}`,
        fromNode: taskId,
        toNode: taskThreeId,
      },
    ]);
  });

  it("an update that drops a waived edge is refused", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        storage.transact((transaction) => {
          seedWaivedEdge(transaction, {
            id: "edge_fixture_waived",
            fromNode: taskId,
            toNode: taskTwoId,
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
      runUpdate(fixture, updateInput(taskId, nodeBaselineRevision, taskBody()));
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
      transaction.get("SELECT id, waived_at FROM edge WHERE id = ?", [
        "edge_fixture_waived",
      ]),
    ) as Readonly<{ id: string; waived_at: number }> | undefined;
    assert.equal(edge?.waived_at, 100);
  });

  it("an update that keeps a waived edge succeeds", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
        storage.transact((transaction) => {
          seedWaivedEdge(transaction, {
            id: "edge_fixture_waived",
            fromNode: taskId,
            toNode: taskTwoId,
            waivedAt: 100,
          });
        });
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    const result = runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
    );
    assert.match(result.revision, /^revision_/);
  });

  it("a kind change is kind-mismatch and writes nothing", (t) => {
    const fixture = build(seedPlanFixture, []);
    t.after(() => fixture.dispose());

    const before = tableCounts(fixture.storage);
    let caught: unknown;
    try {
      runUpdate(
        fixture,
        updateInput(
          taskId,
          nodeBaselineRevision,
          objectiveBody({ parentId: planFixtureIdentities.initiative }),
        ),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "kind-mismatch");
    assert.deepEqual(caught.details, {
      expected: "task",
      actual: "objective",
    });
    const after = tableCounts(fixture.storage);
    assert.equal(after.node, before.node);
    assert.equal(after.edge, before.edge);
    assert.equal(after.plan_revision, before.plan_revision);
  });

  it("one clock read per command", (t) => {
    const fixture = build(seedPlanFixture, [U_REV]);
    t.after(() => fixture.dispose());

    runUpdate(fixture, titleEdit(taskId, nodeBaselineRevision, "Renamed task"));

    const rows = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id, updated_at FROM node ORDER BY id ASC"),
    ) as readonly Readonly<{ id: string; updated_at: number }>[];
    const byId = new Map(rows.map((row) => [row.id, row.updated_at]));
    assert.equal(byId.get(taskId), CLOCK_START);
    assert.deepEqual(
      [...new Set(rows.map((row) => row.updated_at))].sort((a, b) => a - b),
      [1, CLOCK_START],
    );
  });

  it("every readiness transition on node.update carries its matching trigger", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedTask(storage, plan, blobs, taskTwoId);
      },
      [U_REV1, U_EDGE, U_REV2],
    );
    t.after(() => fixture.dispose());

    runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ dependsOn: [taskTwoId] }),
      ),
    );
    runUpdate(fixture, updateInput(taskId, `revision_${U_REV1}`, taskBody()));

    assertTriggersMatchTransitions(fixture.calls);
  });

  it("one pass is a fixed point over a chain of three nodes", (t) => {
    const fixture = build(seedChain, [U_REV]);
    t.after(() => fixture.dispose());

    const hashes = fixture.storage.transact((transaction) => ({
      instruction: fixture.blobs.put(
        transaction,
        encoder.encode(planFixtureBodies.taskInstruction),
      ),
      acceptance: fixture.blobs.put(
        transaction,
        encoder.encode(planFixtureBodies.taskAcceptance),
      ),
    }));
    const write: MutateGraphInput = {
      projectId: fixtureIds.project,
      nodes: [
        {
          id: taskTwoId,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: objectiveId,
          title: "Sibling task",
          instructionBlob: hashes.instruction,
          acceptanceBlob: hashes.acceptance,
          worker: null,
          repositoryId: null,
          revision: nodeBaselineRevision,
          updatedAt: CLOCK_START,
        },
      ],
      insertEdges: [],
      deleteEdgeIds: ["edge_fixture_b"],
      nodeDeletes: [],
      at: CLOCK_START,
      cause: { revision: nodeBaselineRevision, importId: null },
    };

    const first = fixture.storage.transact((transaction) =>
      fixture.plan.mutateGraph(transaction, write),
    );
    assert.deepEqual(first, [
      {
        nodeId: taskTwoId,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const perNode = new Map<string, number>();
    for (const transition of first) {
      perNode.set(transition.nodeId, (perNode.get(transition.nodeId) ?? 0) + 1);
    }
    assert.ok(
      [...perNode.values()].every((count) => count <= 1),
      "a single write must produce at most one transition per node",
    );

    const second = fixture.storage.transact((transaction) =>
      fixture.plan.mutateGraph(transaction, write),
    );
    assert.deepEqual(second, []);
  });

  it("an update that empties an objective keeps its state byte-identical", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedObjective(storage, plan, blobs, objectiveTwoId);
      },
      [U_REV],
    );
    t.after(() => fixture.dispose());

    const before = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, objectiveId),
    );
    assert.ok(before !== null);
    runUpdate(
      fixture,
      updateInput(
        taskId,
        nodeBaselineRevision,
        taskBody({ parentId: objectiveTwoId }),
      ),
    );
    const after = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, objectiveId),
    );
    assert.deepEqual(after, before);
  });

  it("a mismatched trigger pair is refused by the store and writes nothing", (t) => {
    const fixture = build(seedPlanFixture, []);
    t.after(() => fixture.dispose());

    assertMismatchedTriggerRefused(fixture, taskId);
  });
});

function seedChain(storage: Storage, plan: PlanStore, blobs: BlobStore): void {
  seedPlanFixture(storage, plan, blobs);
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id: taskTwoId,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: objectiveId,
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
        {
          id: taskThreeId,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: objectiveId,
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
      insertEdges: [
        { id: "edge_fixture_b", fromNode: taskTwoId, toNode: taskId },
        { id: "edge_fixture_c", fromNode: taskThreeId, toNode: taskTwoId },
      ],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

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
  fixture: UpdateFixture,
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
