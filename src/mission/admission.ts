import type { Transaction } from "../kernel/store.ts";
import { NodeState, type WorkQueue } from "./contract.ts";

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  NodeState.Completed,
  NodeState.Discarded,
]);
const IMPORT_STATES: ReadonlySet<string> = new Set([
  NodeState.Pending,
  NodeState.Available,
]);
const INITIAL_ATTEMPT = 0;
const DEFAULT_PRIORITY = 0;

export function isTerminal(state: string | null): boolean {
  return state !== null && TERMINAL_STATES.has(state);
}

export function importAdmissible(
  state: string | null,
  attempt: number | null,
): boolean {
  return (
    state !== null &&
    IMPORT_STATES.has(state) &&
    (attempt ?? INITIAL_ATTEMPT) === INITIAL_ATTEMPT
  );
}

export function nodeApiWriteAdmissible(state: string | null): boolean {
  return !isTerminal(state);
}

export function reconcileJob(
  tx: Transaction,
  workQueue: WorkQueue,
  nodeId: string,
  projectId: string,
  priority: number | null,
  prevClaimable: boolean,
  isClaimable: boolean,
): void {
  if (prevClaimable === isClaimable) return;
  if (isClaimable) {
    workQueue.insert(tx, nodeId, projectId, priority ?? DEFAULT_PRIORITY);
    return;
  }
  workQueue.delete(tx, nodeId);
}
