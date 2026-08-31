import { aggregate } from "../../domain/aggregation.ts";
import {
  parseVerifyBlock,
  VerifyBlockError,
} from "../../domain/verify-block.ts";
import {
  terminalStates,
  type NodeKind,
  type NodeState,
  type TerminalState,
} from "../../domain/state.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Execution } from "../../services/execution/index.ts";

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
  deliverable: string | null;
  verify: { paths: string[]; commands: string[] } | null;
  repositoryId: string | null;
  repo: string | null;
  revision: string;
  updatedAt: number;
  attestedObjectId: string | null;
  projection: "done" | "partial" | "discarded" | null;
}>;

export type ShowNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  execution: Execution;
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

function isTerminalState(state: NodeState): state is TerminalState {
  return terminalStates.some((terminal) => terminal === state);
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
    const children = dependencies.plan
      .readAllNodes(transaction)
      .filter((node) => node.parentId === stored.id)
      .sort((left, right) => compareIds(left.id, right.id));
    const states = children.map((node) => node.state).filter(isTerminalState);
    const projection =
      stored.kind === "objective" &&
      children.length > 0 &&
      states.length === children.length
        ? aggregate("objective", states)
        : null;
    const run =
      stored.kind === "objective"
        ? dependencies.execution.latestRunOfNode(transaction, stored.id)
        : null;
    const { verifyJson, ...storedWithoutVerifyJson } = stored;
    return {
      ...storedWithoutVerifyJson,
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
      verify: parseNodeVerifyBlock(stored.id, verifyJson),
      repo:
        stored.repositoryId === null
          ? null
          : dependencies.plan.readRepositoryName(
              transaction,
              stored.repositoryId,
            ),
      attestedObjectId: run?.headOid ?? null,
      projection,
    };
  });
}

function parseNodeVerifyBlock(
  nodeId: string,
  verifyJson: string | null,
): { paths: string[]; commands: string[] } | null {
  if (verifyJson === null) {
    return null;
  }
  try {
    return parseVerifyBlock(verifyJson);
  } catch (error) {
    if (error instanceof VerifyBlockError) {
      Object.assign(error, { nodeId });
    }
    throw error;
  }
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
