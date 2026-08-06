import type { Transaction } from "../storage/index.ts";
import type { NodeKind } from "../../domain/state.ts";
import type {
  StoredNode,
  StoredEdge,
  ContainmentFacts,
  ValidationContext,
} from "../../domain/plan-graph.ts";

export type RevisionRecord = Readonly<{
  id: string;
  parentId: string | null;
  importId: string;
  submittedBlob: string;
  choicesBlob: string;
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
  readContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts;
  readSubtreeContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts;
  insertRevision(
    transaction: Transaction,
    record: RevisionRecord & Readonly<{ projectId: string }>,
  ): void;
  upsertNode(transaction: Transaction, node: NodeWrite): void;
  insertEdge(transaction: Transaction, edge: EdgeWrite): void;
  deleteEdge(transaction: Transaction, id: string): void;
}
