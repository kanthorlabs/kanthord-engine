import type { NodeKind, NodeState } from "./state.ts";

export type StoredNode = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  instructionBlob: string;
  acceptanceBlob: string | null;
  worker: string | null;
  repositoryId: string | null;
  state: NodeState;
  blockReason: string | null;
  discardReason: string | null;
  revision: string;
  updatedAt: number;
  deliverable: string | null;
  verifyJson: string | null;
  dependencies: readonly string[];
}>;

export type StoredEdge = Readonly<{
  id: string;
  fromNode: string;
  toNode: string;
  waivedAt: number | null;
}>;

export type ContainmentFacts = Readonly<{
  lease: boolean;
  workspace: boolean;
  attemptCommit: boolean;
  retainedCommit: boolean;
}>;

export const executionBlockers = [
  "lease",
  "workspace",
  "run",
  "attempt",
  "commit",
  "check-result",
  "git-operation",
] as const;
export type ExecutionBlocker = (typeof executionBlockers)[number];

export type SubtreeExecutionFact = Readonly<{
  nodeId: string;
  blocker: ExecutionBlocker;
}>;

export type ValidationContext = Readonly<{
  workerKinds: readonly string[];
  boundRepositories: readonly string[];
  knownRepositories: readonly string[];
}>;
