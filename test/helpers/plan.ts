import { YamlDocumentReader } from "../../src/services/document/yaml.ts";
import type { DocumentReader } from "../../src/services/document/index.ts";
import { SqlitePlanStore } from "../../src/services/plan/sqlite.ts";
import type { PlanStore } from "../../src/services/plan/index.ts";
import { DependencyReadiness } from "../../src/services/readiness/dependency.ts";
import type { Readiness } from "../../src/services/readiness/index.ts";
import type {
  EventLog,
  RecordedEvent,
} from "../../src/services/event/index.ts";
import { GraphologyGraph } from "../../src/services/graph/graphology.ts";
import type { Graph } from "../../src/services/graph/index.ts";
import { fixtureIds, seedGraph, seedRegistry } from "./rows.ts";
import { SqliteBlobStore } from "../../src/services/blob/sqlite.ts";
import type { BlobStore } from "../../src/services/blob/index.ts";
import { NodeWriteRevision } from "../../src/services/revision/node-write.ts";
import type { Revision } from "../../src/services/revision/index.ts";
import type { Clock } from "../../src/services/clock/index.ts";
import type { Storage } from "../../src/services/storage/index.ts";
import type { ReadinessTransition } from "../../src/domain/readiness.ts";

export function createReadiness(
  events: EventLog,
  instanceId = "daemon_test",
): Readiness {
  return new DependencyReadiness({ events, instanceId });
}

function discardingReadiness(): Readiness {
  const events: EventLog = {
    append(): RecordedEvent {
      return {
        id: "event_1",
        subjectKind: "node",
        subjectId: "node_a",
        type: "node.ready",
        actorKind: "daemon",
        actorId: "daemon_test",
        payload: {},
        occurredAt: 0,
      };
    },
    list(): readonly RecordedEvent[] {
      return [];
    },
  };
  return createReadiness(events);
}

export function createPlanStore(
  readiness: Readiness = discardingReadiness(),
): PlanStore {
  return new SqlitePlanStore({ readiness });
}

export type RecordedPlanCall = Readonly<{
  method: "mutateGraph" | "setNodeState";
  input: unknown;
  transitions: readonly ReadinessTransition[];
}>;

export function createRecordingPlanStore(plan: PlanStore): Readonly<{
  plan: PlanStore;
  calls: readonly RecordedPlanCall[];
}> {
  const calls: RecordedPlanCall[] = [];
  const wrapped: PlanStore = {
    readGraph(transaction, projectId) {
      return plan.readGraph(transaction, projectId);
    },
    readNode(transaction, id) {
      return plan.readNode(transaction, id);
    },
    readAllNodes(transaction) {
      return plan.readAllNodes(transaction);
    },
    newestRevision(transaction, projectId) {
      return plan.newestRevision(transaction, projectId);
    },
    listRevisions(transaction, projectId) {
      return plan.listRevisions(transaction, projectId);
    },
    findByImportId(transaction, projectId, importId) {
      return plan.findByImportId(transaction, projectId, importId);
    },
    readValidationContext(transaction, projectId) {
      return plan.readValidationContext(transaction, projectId);
    },
    readRepositoryName(transaction, repositoryId) {
      return plan.readRepositoryName(transaction, repositoryId);
    },
    readContainmentFacts(transaction, nodeId) {
      return plan.readContainmentFacts(transaction, nodeId);
    },
    readSubtreeContainmentFacts(transaction, nodeId) {
      return plan.readSubtreeContainmentFacts(transaction, nodeId);
    },
    readSubtree(transaction, nodeId) {
      return plan.readSubtree(transaction, nodeId);
    },
    readSubtreeExecutionFacts(transaction, nodeId) {
      return plan.readSubtreeExecutionFacts(transaction, nodeId);
    },
    insertRevision(transaction, record) {
      return plan.insertRevision(transaction, record);
    },
    mutateGraph(transaction, input) {
      const transitions = plan.mutateGraph(transaction, input);
      calls.push({ method: "mutateGraph", input, transitions });
      return transitions;
    },
    setNodeState(transaction, input) {
      const transitions = plan.setNodeState(transaction, input);
      calls.push({ method: "setNodeState", input, transitions });
      return transitions;
    },
  };
  return { plan: wrapped, calls };
}

export function createBlobStore(storage: Storage, clock: Clock): BlobStore {
  return new SqliteBlobStore({ storage, clock });
}

export function createRevision(blobs: BlobStore, plan: PlanStore): Revision {
  return new NodeWriteRevision({ blobs, plan });
}

export function createPlanReader(): DocumentReader {
  return new YamlDocumentReader();
}

export function createPlanGraph(): Graph {
  return new GraphologyGraph();
}

export const nodeBaselineRevision = "revision_00000000000000000000000000";

export function reseedBaselineRevision(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) SELECT ?, project_id, parent_id, 'node-write', NULL, NULL, NULL, accepted_blob FROM plan_revision WHERE id = ?",
      [nodeBaselineRevision, fixtureIds.planRevision],
    );
    transaction.run("UPDATE node SET revision = ? WHERE revision = ?", [
      nodeBaselineRevision,
      fixtureIds.planRevision,
    ]);
    transaction.run("DELETE FROM plan_revision WHERE id = ?", [
      fixtureIds.planRevision,
    ]);
  });
}

export const planFixtureIdentities = {
  initiative: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  objective: "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV",
  task: "task_01DRZ3NDEKTSV4RRFFQ69G5FAV",
  taskTwo: "task_01ERZ3NDEKTSV4RRFFQ69G5FAV",
} as const;

export const planFixtureBodies = {
  initiative: "Do the initiative work.\n",
  objective: "Do the objective work.\n",
  taskInstruction: "Do the task work.\n",
  taskAcceptance: "## Acceptance criteria\n- it works\n",
} as const;

export function seedPlanFixture(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
): void {
  const encoder = new TextEncoder();
  storage.transact((transaction) => {
    seedRegistry(transaction);
    seedGraph(transaction);
    transaction.run("DELETE FROM node WHERE project_id = ?", [
      fixtureIds.project,
    ]);
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id: planFixtureIdentities.initiative,
          projectId: fixtureIds.project,
          kind: "initiative",
          parentId: null,
          title: "Harden the verify CLI",
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
          id: planFixtureIdentities.objective,
          projectId: fixtureIds.project,
          kind: "objective",
          parentId: planFixtureIdentities.initiative,
          title: "Harden the verify CLI",
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
          id: planFixtureIdentities.task,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: planFixtureIdentities.objective,
          title: "Harden the verify CLI",
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
