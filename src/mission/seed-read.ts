import type { Transaction } from "../kernel/store.ts";
import {
  HEAD_COMMIT_SUBJECT,
  type SeedExecution,
  type SeedNode,
} from "../worker/contract.ts";
import { AssetKind, NodeState, repositoryAddressSchema } from "./contract.ts";
import { getRevision } from "./node-read.ts";
import {
  readAssets,
  readPromptCommits,
  readReleaseEvidence,
} from "./record-store.ts";
import { readNode } from "./store.ts";

const CLOSED_STATES: readonly string[] = [
  NodeState.Completed,
  NodeState.Discarded,
];

function pushedHeads(
  tx: Transaction,
  execution: SeedExecution,
): Record<string, string> {
  const pushed = readReleaseEvidence(
    tx,
    execution.node_id,
    execution.attempt,
    execution.execution_id,
  )
    .filter(({ subject }) => subject === HEAD_COMMIT_SUBJECT)
    .at(-1);
  if (pushed === undefined) return {};
  return Object.fromEntries(
    readAssets(tx, pushed.id)
      .filter(({ kind }) => kind === AssetKind.Repository)
      .map(({ content }) => repositoryAddressSchema.parse(JSON.parse(content)))
      .map(({ binding_id, commit }) => [binding_id, commit]),
  );
}

function attemptBases(
  tx: Transaction,
  execution: SeedExecution,
): Record<string, string> {
  return Object.fromEntries(
    (readPromptCommits(tx, execution.node_id, execution.attempt) ?? []).map(
      ({ binding_id, commit }) => [binding_id, commit],
    ),
  );
}

export function seedNodeOf(
  tx: Transaction,
  execution: SeedExecution,
): SeedNode | null {
  const node = readNode(tx, execution.node_id);
  if (
    node === null ||
    node.retired_at !== null ||
    CLOSED_STATES.includes(node.state)
  )
    return null;
  return {
    revision: getRevision(tx, node.id, execution.pinned_revision),
    heads: {
      ...attemptBases(tx, execution),
      ...pushedHeads(tx, execution),
    },
  };
}
