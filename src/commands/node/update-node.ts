import type { ActorRow } from "../../domain/actor.ts";
import {
  validateCandidateCompleteness,
  validateCandidateStructural,
  type Candidate,
  type CandidateNode,
} from "../../domain/plan-candidate.ts";
import { containmentMovable } from "../../domain/plan-containment.ts";
import { differingFields } from "../../domain/plan-diff.ts";
import type { Finding } from "../../domain/plan-finding.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import { nodeWriteLegality } from "../../domain/node-write-legality.ts";
import type { ResolvedDocument } from "../../domain/plan-identity.ts";
import { comparePaths } from "../../domain/plan-path.ts";
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

export type NodeUpdateBody = Readonly<
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

export type UpdateNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  revision: Revision;
}>;

export type UpdateNodeInput = Readonly<{
  id: string;
  fromRevision: string;
  node: NodeUpdateBody;
  actor: ActorRow;
}>;

export type UpdateNodeResult = Readonly<{
  revision: string;
  completeness: readonly Finding[];
}>;

function pairKey(fromNode: string, toNode: string): string {
  return `${fromNode}\u0000${toNode}`;
}

export function updateNode(
  dependencies: UpdateNodeDependencies,
  input: UpdateNodeInput,
): UpdateNodeResult {
  return dependencies.storage.transact((transaction) => {
    const at = dependencies.clock.now();

    const before = dependencies.plan.readNode(transaction, input.id);
    if (before === null) {
      throw new NodeWriteError("node-not-found", `no node ${input.id}`);
    }

    if (input.node.kind !== before.kind) {
      throw new NodeWriteError(
        "kind-mismatch",
        `the write names kind ${input.node.kind}, the stored node is a ${before.kind}`,
        { expected: before.kind, actual: input.node.kind },
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

    const submittedInstruction = dependencies.blobs.hash(
      encoder.encode(input.node.instruction),
    );
    const submittedAcceptance =
      input.node.kind === "task"
        ? dependencies.blobs.hash(encoder.encode(input.node.acceptance))
        : null;
    const submitted: ResolvedDocument = {
      path: "",
      kind: input.node.kind,
      id: input.id,
      title: input.node.title,
      dependsOn: input.node.dependsOn,
      worker: input.node.worker,
      repo: repositoryId,
      deliverable: null,
      verify: null,
      derivedParentPath: null,
      instruction: input.node.instruction,
      acceptance: input.node.kind === "task" ? input.node.acceptance : null,
      identity: input.id,
      minted: false,
      parentIdentity: parentId,
      dependencies: dependsOn,
    };
    const fields = differingFields(before, submitted, {
      instruction: submittedInstruction,
      acceptance: submittedAcceptance,
    });

    const guard = revisionGuardFor(
      fields.includes("parent") || fields.includes("depends_on")
        ? "update-topology"
        : "update-fields",
    );
    const expected =
      guard === "node"
        ? before.revision
        : dependencies.plan.newestRevision(transaction, before.projectId);
    if (input.fromRevision !== expected) {
      throw new NodeWriteError(
        "stale-revision",
        `the write names ${String(input.fromRevision)}, the guard expects ${String(expected)}`,
        { guard, expected, actual: input.fromRevision },
      );
    }

    const facts =
      before.kind === "task"
        ? dependencies.plan.readContainmentFacts(transaction, input.id)
        : dependencies.plan.readSubtreeContainmentFacts(transaction, input.id);
    const legality = nodeWriteLegality({
      state: before.state,
      fields,
      containmentMovable: containmentMovable(before.kind, facts),
    });
    if (!legality.legal) {
      if (legality.refusal === "state") {
        throw new NodeWriteError(
          "illegal-transition",
          `a structural edit is refused at ${before.state}`,
          { nodes: [{ id: input.id, state: before.state }] },
        );
      }
      const blockers: Readonly<{ nodeId: string; blocker: string }>[] = [];
      if (facts.lease) blockers.push({ nodeId: input.id, blocker: "lease" });
      if (facts.workspace) {
        blockers.push({ nodeId: input.id, blocker: "workspace" });
      }
      if (facts.attemptCommit) {
        blockers.push({ nodeId: input.id, blocker: "attempt-commit" });
      }
      if (facts.retainedCommit) {
        blockers.push({ nodeId: input.id, blocker: "retained-commit" });
      }
      throw new NodeWriteError(
        "binding-in-use",
        "the node containment is not movable",
        { blockers },
      );
    }

    const revisionId = dependencies.ids.mint("planRevision");
    const newest = dependencies.plan.newestRevision(
      transaction,
      before.projectId,
    );

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

    const { nodes: stored, edges: storedEdges } = dependencies.plan.readGraph(
      transaction,
      before.projectId,
    );
    const after: readonly StoredNode[] = stored.map((node) =>
      node.id === input.id
        ? {
            ...node,
            kind: input.node.kind,
            parentId,
            title: input.node.title,
            instructionBlob,
            acceptanceBlob,
            worker: input.node.worker,
            repositoryId,
            revision: revisionId,
            updatedAt: at,
            dependencies: dependsOn,
          }
        : node,
    );

    if (fields.includes("parent")) {
      const terminal = terminalAncestor(after, parentId);
      if (terminal !== null) {
        throw new NodeWriteError(
          "illegal-transition",
          `the ancestor ${terminal.id} is ${terminal.state}, not startable`,
        );
      }
    }

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
      if (node.id === input.id) {
        return {
          id: node.id,
          kind: node.kind,
          parentId: node.parentId,
          title: node.title,
          instructionBlob: node.instructionBlob,
          acceptanceBlob: node.acceptanceBlob,
          worker: node.worker,
          repositoryId: repositoryName,
          deliverable: node.deliverable,
          verifyJson: node.verifyJson,
          dependencies: [...node.dependencies],
          source: "database" as const,
        };
      }
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
      projectId: before.projectId,
      revisionId,
      parentRevision: newest,
      documents,
    });

    const storedPairs = new Map(
      storedEdges.map((edge) => [pairKey(edge.fromNode, edge.toNode), edge]),
    );
    const wantedPairs = new Map<
      string,
      Readonly<{ fromNode: string; toNode: string }>
    >();
    for (const node of after) {
      for (const dependency of node.dependencies) {
        if (dependency === node.id) continue;
        wantedPairs.set(pairKey(node.id, dependency), {
          fromNode: node.id,
          toNode: dependency,
        });
      }
    }
    const deleteEdgeIds: string[] = [];
    for (const [key, edge] of storedPairs) {
      if (!wantedPairs.has(key)) {
        if (edge.waivedAt !== null) {
          throw new NodeWriteError(
            "binding-in-use",
            "the write drops a waived edge",
            { blockers: [{ nodeId: input.id, blocker: "waived-edge" }] },
          );
        }
        deleteEdgeIds.push(edge.id);
      }
    }
    const toInsert = [...wantedPairs.values()].filter(
      (pair) => !storedPairs.has(pairKey(pair.fromNode, pair.toNode)),
    );
    toInsert.sort((left, right) => {
      const byFrom = comparePaths(left.fromNode, right.fromNode);
      if (byFrom !== 0) return byFrom;
      return comparePaths(left.toNode, right.toNode);
    });
    const insertEdges: EdgeWrite[] = [];
    for (const pair of toInsert) {
      insertEdges.push({
        id: dependencies.ids.mint("edge"),
        fromNode: pair.fromNode,
        toNode: pair.toNode,
      });
    }

    const nodeWrite: NodeWrite = {
      id: input.id,
      projectId: before.projectId,
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
      projectId: before.projectId,
      nodes: [nodeWrite],
      insertEdges,
      deleteEdgeIds,
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
      subjectId: input.id,
      type: "node.updated",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      payload: { fields, revision: revisionId },
    });

    return { revision: revisionId, completeness };
  });
}
