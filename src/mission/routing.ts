import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal, reconcileJob } from "./admission.ts";
import { NodeKind, NodeState, type WorkQueue } from "./contract.ts";
import { buildDependencyClosureOf } from "./graph.ts";
import { readDependencies, readMissionNodes, setNodeState } from "./store.ts";

export function claimableMap(
  tx: Transaction,
  missionId: string,
): Map<string, boolean> {
  const nodes = readMissionNodes(tx, missionId);
  const nonterminalParents = new Set(
    nodes
      .filter(
        (node) =>
          node.retired_at === null &&
          node.kind === NodeKind.Objective &&
          !isTerminal(node.state),
      )
      .map((node) => node.parent_id),
  );
  return new Map(
    nodes.map((node) => [
      node.id,
      node.retired_at === null &&
        node.state === NodeState.Available &&
        (node.kind === NodeKind.Objective ||
          (node.kind === NodeKind.Initiative &&
            !nonterminalParents.has(node.id))),
    ]),
  );
}

export function routeMission(tx: Transaction, missionId: string): void {
  const nodes = readMissionNodes(tx, missionId).filter(
    (node) => node.retired_at === null,
  );
  const states = new Map(nodes.map((node) => [node.id, node.state]));
  const parents = new Map<string, string>();
  for (const node of nodes) {
    if (node.parent_id !== null) parents.set(node.id, node.parent_id);
  }
  const dependencies = readDependencies(tx, missionId);
  for (const node of nodes) {
    if (
      node.kind === NodeKind.Task ||
      (node.state !== NodeState.Pending && node.state !== NodeState.Available)
    )
      continue;
    const closure = buildDependencyClosureOf(node.id, dependencies, parents);
    const available = Array.from(closure).every(
      (id) => states.get(id) === NodeState.Completed,
    );
    setNodeState(
      tx,
      node.id,
      available ? NodeState.Available : NodeState.Pending,
    );
  }
}

export function reconcileMission(
  tx: Transaction,
  workQueue: WorkQueue,
  missionId: string,
  projectId: string,
  before: Map<string, boolean>,
): void {
  const after = claimableMap(tx, missionId);
  const nodes = new Map(
    readMissionNodes(tx, missionId).map((node) => [node.id, node]),
  );
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const node = nodes.get(id);
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
