import type { ActorRow } from "../../domain/actor.ts";
import {
  validateCandidateCompleteness,
  type Candidate,
  type CandidateNode,
} from "../../domain/plan-candidate.ts";
import type { Finding } from "../../domain/plan-finding.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import { revisionGuardFor } from "../../domain/revision-guard.ts";
import type { NodeState } from "../../domain/state.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { NodeWrite, PlanStore } from "../../services/plan/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import { NodeWriteError } from "./refusal.ts";

export type DeleteNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  revision: Revision;
}>;

export type DeleteNodeInput = Readonly<{
  id: string;
  fromRevision: string;
  actor: ActorRow;
}>;

export type DeleteNodeResult = Readonly<{
  revision: string;
  deleted: readonly string[];
  completeness: readonly Finding[];
}>;

const deletableStates = ["pending", "ready", "blocked"] as const;

const compareBytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

export function deleteNode(
  dependencies: DeleteNodeDependencies,
  input: DeleteNodeInput,
): DeleteNodeResult {
  return dependencies.storage.transact((transaction) => {
    const before = dependencies.plan.readNode(transaction, input.id);
    if (before === null) {
      throw new NodeWriteError("node-not-found", `no node ${input.id}`);
    }

    const newest = dependencies.plan.newestRevision(
      transaction,
      before.projectId,
    );
    if (input.fromRevision !== newest) {
      throw new NodeWriteError(
        "stale-revision",
        `the write names ${String(input.fromRevision)}, the newest revision is ${String(newest)}`,
        {
          guard: revisionGuardFor("delete"),
          expected: newest,
          actual: input.fromRevision,
        },
      );
    }

    const at = dependencies.clock.now();

    const deleteSet = dependencies.plan.readSubtree(transaction, input.id);
    const deleteSetSet = new Set(deleteSet);

    const covering = dependencies.plan.runCoversNode(
      transaction,
      [input.id],
      at,
    );
    if (covering !== null) {
      throw new NodeWriteError(
        "subtree-busy",
        "an active run covers the subtree",
        {
          relation: covering.relation,
          nodeId: covering.nodeId,
          runId: covering.runId,
          expiresAt: covering.expiresAt,
        },
      );
    }

    const { nodes: stored, edges: storedEdges } = dependencies.plan.readGraph(
      transaction,
      before.projectId,
    );
    const storedById = new Map(stored.map((node) => [node.id, node]));

    const offending: Readonly<{ id: string; state: NodeState }>[] = [];
    for (const id of deleteSet) {
      const node = storedById.get(id);
      if (
        node !== undefined &&
        !(deletableStates as readonly string[]).includes(node.state)
      ) {
        offending.push({ id, state: node.state });
      }
    }
    if (offending.length > 0) {
      offending.sort((left, right) => compareBytes(left.id, right.id));
      throw new NodeWriteError(
        "illegal-transition",
        "a node in the subtree is not deletable",
        { nodes: offending },
      );
    }

    const blockers = dependencies.plan.readSubtreeExecutionFacts(
      transaction,
      input.id,
    );
    if (blockers.length > 0) {
      throw new NodeWriteError(
        "binding-in-use",
        "the subtree is referenced by execution rows",
        { blockers },
      );
    }

    const waivedBlockers: Readonly<{
      nodeId: string;
      blocker: "waived-edge";
    }>[] = [];
    const seenWaived = new Set<string>();
    for (const edge of storedEdges) {
      if (edge.waivedAt === null) continue;
      for (const id of [edge.fromNode, edge.toNode]) {
        if (!deleteSetSet.has(id) || seenWaived.has(id)) continue;
        seenWaived.add(id);
        waivedBlockers.push({ nodeId: id, blocker: "waived-edge" });
      }
    }
    if (waivedBlockers.length > 0) {
      waivedBlockers.sort((left, right) =>
        compareBytes(left.nodeId, right.nodeId),
      );
      throw new NodeWriteError(
        "binding-in-use",
        "the delete drops a waived edge",
        { blockers: waivedBlockers },
      );
    }

    const revisionId = dependencies.ids.mint("planRevision");

    const restampedNodes: NodeWrite[] = [];
    const after: readonly StoredNode[] = stored
      .filter((node) => !deleteSetSet.has(node.id))
      .map((node) => {
        const dependenciesAfter = node.dependencies.filter(
          (dependency) => !deleteSetSet.has(dependency),
        );
        if (dependenciesAfter.length === node.dependencies.length) {
          return node;
        }
        const restamped: StoredNode = {
          ...node,
          dependencies: dependenciesAfter,
          revision: revisionId,
          updatedAt: at,
        };
        restampedNodes.push({
          id: restamped.id,
          projectId: restamped.projectId,
          kind: restamped.kind,
          parentId: restamped.parentId,
          title: restamped.title,
          instructionBlob: restamped.instructionBlob,
          acceptanceBlob: restamped.acceptanceBlob,
          worker: restamped.worker,
          repositoryId: restamped.repositoryId,
          revision: restamped.revision,
          updatedAt: restamped.updatedAt,
        });
        return restamped;
      });
    restampedNodes.sort((left, right) => compareBytes(left.id, right.id));

    const documents = dependencies.revision.render(transaction, {
      nodes: after,
    });
    dependencies.revision.record(transaction, {
      projectId: before.projectId,
      revisionId,
      parentRevision: newest,
      documents,
    });

    const deleteEdgeIds = storedEdges
      .filter(
        (edge) =>
          deleteSetSet.has(edge.fromNode) || deleteSetSet.has(edge.toNode),
      )
      .map((edge) => edge.id);
    deleteEdgeIds.sort(compareBytes);
    dependencies.plan.mutateGraph(transaction, {
      projectId: before.projectId,
      nodes: restampedNodes,
      insertEdges: [],
      deleteEdgeIds,
      nodeDeletes: [...deleteSet],
      at,
      cause: { revision: revisionId, importId: null },
    });

    const context = dependencies.plan.readValidationContext(
      transaction,
      before.projectId,
    );
    const repositoryRows = transaction.all(
      "SELECT id, name FROM repository",
    ) as readonly Readonly<{ id: string; name: string }>[];
    const repositoryNamesById = new Map(
      repositoryRows.map((row) => [row.id, row.name]),
    );
    const candidateNodes: CandidateNode[] = after.map((node) => {
      if (node.repositoryId === null) {
        return { ...node, source: "database" as const };
      }
      const name = repositoryNamesById.get(node.repositoryId);
      if (name === undefined) {
        throw new Error(`repository ${node.repositoryId} is not registered`);
      }
      return { ...node, repositoryId: name, source: "database" as const };
    });
    const candidate: Candidate = { nodes: candidateNodes };
    const completeness = validateCandidateCompleteness(
      { findCycles: (graphInput) => dependencies.graph.cycles(graphInput) },
      { candidate, context },
    );

    const deleted = [...deleteSet];
    deleted.sort(compareBytes);
    for (const id of deleted) {
      const node = storedById.get(id);
      if (node === undefined) {
        throw new Error(`no stored node ${id}`);
      }
      dependencies.events.append(transaction, {
        subjectKind: "node",
        subjectId: id,
        type: "node.deleted",
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        payload: {
          kind: node.kind,
          parentId: node.parentId,
          revision: revisionId,
        },
      });
    }

    return { revision: revisionId, deleted, completeness };
  });
}
