import type { NodeKind, NodeState } from "../../domain/state.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";

export type NodeView = Readonly<{
  id: string;
  projectId: string;
  kind: NodeKind;
  title: string;
  state: NodeState;
  blockReason: string | null;
  discardReason: string | null;
  parentId: string | null;
  dependencies: readonly string[];
  instructionBlob: string;
  acceptanceBlob: string | null;
  instruction: string;
  acceptance: string | null;
  worker: string | null;
  repositoryId: string | null;
  repo: string | null;
  revision: string;
  updatedAt: number;
}>;

export type ShowNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
}>;

const decoder = new TextDecoder();

function readBlobText(
  blobs: BlobStore,
  transaction: Transaction,
  hash: string,
): string {
  const record = blobs.get(hash, transaction);
  if (record === null) {
    throw new Error(`blob ${hash} is missing from the store`);
  }
  return decoder.decode(record.content);
}

export function showNode(
  dependencies: ShowNodeDependencies,
  input: Readonly<{ id: string }>,
): NodeView | null {
  return dependencies.storage.transact((transaction) => {
    const stored = dependencies.plan.readNode(transaction, input.id);
    if (stored === null) {
      return null;
    }
    return {
      ...stored,
      instruction: readBlobText(
        dependencies.blobs,
        transaction,
        stored.instructionBlob,
      ),
      acceptance:
        stored.acceptanceBlob === null
          ? null
          : readBlobText(
              dependencies.blobs,
              transaction,
              stored.acceptanceBlob,
            ),
      repo:
        stored.repositoryId === null
          ? null
          : dependencies.plan.readRepositoryName(
              transaction,
              stored.repositoryId,
            ),
    };
  });
}
