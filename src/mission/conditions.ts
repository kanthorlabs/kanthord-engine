import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import { NodeKind, NodeState, type MissionBindings } from "./contract.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";
import { buildDependencyClosureOf } from "./graph.ts";
import { readOpenAttempt } from "./record-store.ts";
import { readDependencies, readMissionNodes, type NodeRow } from "./store.ts";

const NO_ATTEMPT = 0;
const NO_PENDING_ITEMS = 0;

export function closureUnsatisfied(tx: Transaction, node: NodeRow): string[] {
  const nodes = readMissionNodes(tx, node.mission_id).filter(
    (item) => item.retired_at === null,
  );
  const parents = new Map<string, string>();
  for (const item of nodes)
    if (item.parent_id !== null) parents.set(item.id, item.parent_id);
  const states = new Map(nodes.map((item) => [item.id, item.state]));
  const closure = buildDependencyClosureOf(
    node.id,
    readDependencies(tx, node.mission_id),
    parents,
  );
  return [...closure]
    .filter((id) => states.get(id) !== NodeState.Completed)
    .sort();
}

export function readinessOf(
  tx: Transaction,
  node: NodeRow,
): {
  holds: boolean;
  objectives_not_terminal: string[];
} {
  const objectivesNotTerminal =
    node.kind === NodeKind.Initiative
      ? readMissionNodes(tx, node.mission_id)
          .filter(
            (child) =>
              child.parent_id === node.id &&
              child.kind === NodeKind.Objective &&
              child.retired_at === null &&
              !isTerminal(child.state),
          )
          .map((child) => child.id)
          .sort()
      : [];
  return {
    holds: objectivesNotTerminal.length === NO_PENDING_ITEMS,
    objectives_not_terminal: objectivesNotTerminal,
  };
}

export function continuationHolds(
  tx: Transaction,
  bindings: MissionBindings,
  node: NodeRow,
): boolean {
  const open =
    node.attempt === NO_ATTEMPT ? null : readOpenAttempt(tx, node.id);
  return (
    open !== null &&
    eligibleUnrequested(actionStatesOf(tx, bindings, node.id, open.attempt))
      .length > NO_PENDING_ITEMS
  );
}
