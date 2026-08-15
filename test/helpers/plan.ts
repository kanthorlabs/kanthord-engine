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
import type { Clock } from "../../src/services/clock/index.ts";
import type { Storage } from "../../src/services/storage/index.ts";

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

export function createBlobStore(storage: Storage, clock: Clock): BlobStore {
  return new SqliteBlobStore({ storage, clock });
}

export function createPlanReader(): DocumentReader {
  return new YamlDocumentReader();
}

export function createPlanGraph(): Graph {
  return new GraphologyGraph();
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
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}
