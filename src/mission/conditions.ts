import type { Transaction } from "../kernel/store.ts";
import { type MissionBindings, NodeState } from "./contract.ts";
import { actionStatesOf, eligibleUnrequested } from "./frozen-action.ts";
import { directDependenciesOf } from "./graph.ts";
import { readOpenAttempt } from "./record-store.ts";
import { type NodeRow, readDependencies, readMissionNodes } from "./store.ts";

const NO_ATTEMPT = 0;
const NO_PENDING_ITEMS = 0;

export function closureUnsatisfied(tx: Transaction, node: NodeRow): string[] {
  const states = new Map(
    readMissionNodes(tx, node.mission_id)
      .filter((item) => item.retired_at === null)
      .map((item) => [item.id, item.state]),
  );
  return directDependenciesOf(node.id, readDependencies(tx, node.mission_id))
    .filter((id) => states.get(id) !== NodeState.Completed)
    .sort();
}

export function readinessOf(
  tx: Transaction,
  node: NodeRow,
): {
  holds: boolean;
  unsatisfied_ids: string[];
} {
  const unsatisfiedIds = closureUnsatisfied(tx, node);
  return {
    holds: unsatisfiedIds.length === NO_PENDING_ITEMS,
    unsatisfied_ids: unsatisfiedIds,
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
