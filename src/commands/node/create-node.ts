import type { ActorRow } from "../../domain/actor.ts";
import {
  validateCandidateCompleteness,
  validateCandidateStructural,
  type Candidate,
  type CandidateNode,
} from "../../domain/plan-candidate.ts";
import type { Finding } from "../../domain/plan-finding.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import { terminalAncestor } from "../../domain/plan-ancestry.ts";
import { revisionGuardFor } from "../../domain/revision-guard.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type {
  EdgeWrite,
  NodeWrite,
  PlanStore,
} from "../../services/plan/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import { NodeWriteError } from "./refusal.ts";

const encoder = new TextEncoder();

export type NodeCreateBody = Readonly<
  | {
      kind: "initiative";
      title: string;
      instruction: string;
      worker: string | null;
      dependsOn: readonly string[];
    }
  | {
      kind: "objective";
      title: string;
      parentId: string;
      repo: string;
      instruction: string;
      worker: string | null;
      dependsOn: readonly string[];
    }
  | {
      kind: "task";
      title: string;
      parentId: string;
      instruction: string;
      acceptance: string;
      worker: string | null;
      dependsOn: readonly string[];
    }
>;

export type CreateNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  revision: Revision;
}>;

export type CreateNodeInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  node: NodeCreateBody;
  actor: ActorRow;
}>;

export type CreateNodeResult = Readonly<{
  revision: string;
  id: string;
  completeness: readonly Finding[];
}>;

export function createNode(
  dependencies: CreateNodeDependencies,
  input: CreateNodeInput,
): CreateNodeResult {
  return dependencies.storage.transact((transaction) => {
    const at = dependencies.clock.now();

    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new NodeWriteError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }

    const newest = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );
    if (input.fromRevision !== newest) {
      throw new NodeWriteError(
        "stale-revision",
        `the write names ${String(input.fromRevision)}, the newest revision is ${String(newest)}`,
        {
          guard: revisionGuardFor("create"),
          expected: newest,
          actual: input.fromRevision,
        },
      );
    }

    const id = dependencies.ids.mint(input.node.kind);
    const revisionId = dependencies.ids.mint("planRevision");

    const instructionBlob = dependencies.blobs.put(
      transaction,
      encoder.encode(input.node.instruction),
    );
    let acceptanceBlob: string | null = null;
    if (input.node.kind === "task") {
      acceptanceBlob = dependencies.blobs.put(
        transaction,
        encoder.encode(input.node.acceptance),
      );
    }

    const { nodes: stored } = dependencies.plan.readGraph(
      transaction,
      input.projectId,
    );

    const terminal = terminalAncestor(
      stored,
      input.node.kind === "initiative" ? null : input.node.parentId,
    );
    if (terminal !== null) {
      throw new NodeWriteError(
        "illegal-transition",
        `the ancestor ${terminal.id} is ${terminal.state}, not startable`,
      );
    }

    let repositoryId: string | null = null;
    let repositoryName: string | null = null;
    if (input.node.kind === "objective") {
      repositoryName = input.node.repo;
      const row = transaction.get("SELECT id FROM repository WHERE name = ?", [
        input.node.repo,
      ]) as Readonly<{ id: string }> | undefined;
      repositoryId = row === undefined ? null : row.id;
    }

    const parentId =
      input.node.kind === "initiative" ? null : input.node.parentId;
    const dependsOn = [...new Set(input.node.dependsOn)].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );

    const after: readonly StoredNode[] = [
      ...stored,
      {
        id,
        projectId: input.projectId,
        kind: input.node.kind,
        parentId,
        title: input.node.title,
        instructionBlob,
        acceptanceBlob,
        worker: input.node.worker,
        assignment: null,
        repositoryId,
        state: "pending",
        blockReason: null,
        discardReason: null,
        revision: revisionId,
        updatedAt: at,
        deliverable: null,
        verifyJson: null,
        dependencies: dependsOn,
      },
    ];

    const context = dependencies.plan.readValidationContext(
      transaction,
      input.projectId,
    );
    const repositoryRows = transaction.all(
      "SELECT id, name FROM repository",
    ) as readonly Readonly<{ id: string; name: string }>[];
    const repositoryNamesById = new Map(
      repositoryRows.map((row) => [row.id, row.name]),
    );
    const candidateNodes: CandidateNode[] = stored.map((node) => {
      if (node.repositoryId === null) {
        return { ...node, source: "database" as const };
      }
      const name = repositoryNamesById.get(node.repositoryId);
      if (name === undefined) {
        throw new Error(`repository ${node.repositoryId} is not registered`);
      }
      return { ...node, repositoryId: name, source: "database" as const };
    });
    candidateNodes.push({
      id,
      kind: input.node.kind,
      parentId,
      title: input.node.title,
      instructionBlob,
      acceptanceBlob,
      worker: input.node.worker,
      repositoryId: repositoryName,
      deliverable: null,
      verifyJson: null,
      dependencies: dependsOn,
      source: "database",
    });
    const candidate: Candidate = { nodes: candidateNodes };

    const structural = validateCandidateStructural(
      { findCycles: (graphInput) => dependencies.graph.cycles(graphInput) },
      { candidate, context },
    );
    if (structural.length > 0) {
      throw new NodeWriteError(
        "plan-invalid",
        "the write builds an invalid graph",
        { findings: structural },
      );
    }

    const documents = dependencies.revision.render(transaction, {
      nodes: after,
    });
    dependencies.revision.record(transaction, {
      projectId: input.projectId,
      revisionId,
      parentRevision: newest,
      documents,
    });

    const insertEdges: EdgeWrite[] = [];
    for (const dependency of dependsOn) {
      insertEdges.push({
        id: dependencies.ids.mint("edge"),
        fromNode: id,
        toNode: dependency,
      });
    }
    const nodeWrite: NodeWrite = {
      id,
      projectId: input.projectId,
      kind: input.node.kind,
      parentId,
      title: input.node.title,
      instructionBlob,
      acceptanceBlob,
      worker: input.node.worker,
      repositoryId,
      revision: revisionId,
      updatedAt: at,
    };
    dependencies.plan.mutateGraph(transaction, {
      projectId: input.projectId,
      nodes: [nodeWrite],
      insertEdges,
      deleteEdgeIds: [],
      nodeDeletes: [],
      at,
      cause: { revision: revisionId, importId: null },
    });

    const completeness = validateCandidateCompleteness(
      { findCycles: (graphInput) => dependencies.graph.cycles(graphInput) },
      { candidate, context },
    );

    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: id,
      type: "node.created",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      payload: { kind: input.node.kind, parentId, revision: revisionId },
    });

    return { revision: revisionId, id, completeness };
  });
}
