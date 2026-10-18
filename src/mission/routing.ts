import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { reconcileJob } from "./admission.ts";
import { NodeState, type WorkQueue, type MissionBindings } from "./contract.ts";
import { readinessOf, continuationHolds } from "./conditions.ts";
import {
  readLiveMissionNodes,
  readNode,
  readRoutableNodes,
  setNodeState,
  type NodeRow,
} from "./store.ts";

const NO_UNMET_DEPENDENCIES = 0;

export function nodeClaimable(
  tx: Transaction,
  node: NodeRow,
  bindings: MissionBindings,
): boolean {
  if (node.retired_at !== null) return false;
  if (node.state === NodeState.Available) return true;
  if (node.state === NodeState.Waiting) return readinessOf(tx, node).holds;
  if (node.state === NodeState.ExternalRequested)
    return continuationHolds(tx, bindings, node);
  return false;
}

function claimableOf(
  tx: Transaction,
  nodes: readonly NodeRow[],
  bindings: MissionBindings,
): Map<string, boolean> {
  return new Map(
    nodes.map((node) => [node.id, nodeClaimable(tx, node, bindings)]),
  );
}

export function claimableMap(
  tx: Transaction,
  missionId: string,
  bindings: MissionBindings,
): Map<string, boolean> {
  return claimableOf(tx, readLiveMissionNodes(tx, missionId), bindings);
}

export function routeMission(tx: Transaction, missionId: string): void {
  for (const node of readRoutableNodes(tx, missionId)) {
    const state =
      node.unmet === NO_UNMET_DEPENDENCIES
        ? NodeState.Available
        : NodeState.Pending;
    if (state !== node.state) setNodeState(tx, node.id, state);
  }
}

export function reconcileMission(
  tx: Transaction,
  workQueue: WorkQueue,
  missionId: string,
  projectId: string,
  before: Map<string, boolean>,
  bindings: MissionBindings,
): void {
  const live = readLiveMissionNodes(tx, missionId);
  const after = claimableOf(tx, live, bindings);
  const nodes = new Map(live.map((node) => [node.id, node]));
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const node = nodes.get(id) ?? readNode(tx, id);
    assert.ok(node, "Reconciliation requires persistent node rows.");
    assert.equal(
      node.mission_id,
      missionId,
      "Reconciled nodes belong to the mission.",
    );
    reconcileJob(
      tx,
      workQueue,
      id,
      projectId,
      node.priority,
      before.get(id) ?? false,
      after.get(id) ?? false,
    );
  }
}
