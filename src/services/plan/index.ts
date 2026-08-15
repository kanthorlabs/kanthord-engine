import type { Transaction } from "../storage/index.ts";
import type { NodeKind, NodeState } from "../../domain/state.ts";
import type { NodeTriggerId } from "../../domain/node-trigger.ts";
import type { ReadinessTransition } from "../../domain/readiness.ts";
import type { ReadinessCause } from "../readiness/index.ts";
import type { RevisionOrigin } from "../../domain/plan-revision.ts";
import type {
  StoredNode,
  StoredEdge,
  ContainmentFacts,
  SubtreeExecutionFact,
  ValidationContext,
} from "../../domain/plan-graph.ts";

export type RevisionRecord = Readonly<{
  id: string;
  parentId: string | null;
  origin: RevisionOrigin;
  importId: string | null;
  submittedBlob: string | null;
  choicesBlob: string | null;
  acceptedBlob: string;
}>;

export type NodeWrite = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  instructionBlob: string;
  acceptanceBlob: string | null;
  worker: string | null;
  repositoryId: string | null;
  revision: string;
  updatedAt: number;
}>;

export type EdgeWrite = Readonly<{
  id: string;
  fromNode: string;
  toNode: string;
}>;

export type MutateGraphInput = Readonly<{
  projectId: string;
  nodes: readonly NodeWrite[];
  insertEdges: readonly EdgeWrite[];
  deleteEdgeIds: readonly string[];
  nodeDeletes: readonly string[];
  at: number;
  cause: ReadinessCause;
}>;

export type SetNodeStateInput = Readonly<{
  id: string;
  from: NodeState;
  to: NodeState;
  trigger: NodeTriggerId;
  blockReason: string | null;
  at: number;
  cause: ReadinessCause;
}>;

export interface PlanStore {
  readGraph(
    transaction: Transaction,
    projectId: string,
  ): Readonly<{
    nodes: readonly StoredNode[];
    edges: readonly StoredEdge[];
  }>;
  readNode(transaction: Transaction, id: string): StoredNode | null;
  readAllNodes(transaction: Transaction): readonly StoredNode[];
  newestRevision(transaction: Transaction, projectId: string): string | null;
  listRevisions(
    transaction: Transaction,
    projectId: string,
  ): readonly RevisionRecord[];
  findByImportId(
    transaction: Transaction,
    projectId: string,
    importId: string,
  ): RevisionRecord | null;
  readValidationContext(
    transaction: Transaction,
    projectId: string,
  ): ValidationContext;
  readRepositoryName(
    transaction: Transaction,
    repositoryId: string,
  ): string | null;
  readContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts;
  readSubtreeContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts;
  readSubtree(transaction: Transaction, nodeId: string): readonly string[];
  readSubtreeExecutionFacts(
    transaction: Transaction,
    nodeId: string,
  ): readonly SubtreeExecutionFact[];
  insertRevision(
    transaction: Transaction,
    record: RevisionRecord & Readonly<{ projectId: string }>,
  ): void;
  mutateGraph(
    transaction: Transaction,
    input: MutateGraphInput,
  ): readonly ReadinessTransition[];
  setNodeState(
    transaction: Transaction,
    input: SetNodeStateInput,
  ): readonly ReadinessTransition[];
}
