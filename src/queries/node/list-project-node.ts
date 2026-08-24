import type { Clock } from "../../services/clock/index.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { toNodeListItem, type NodeListItem } from "../../domain/node-view.ts";

export type ListProjectNodeRefusal = "project-not-found";

export class ListProjectNodeError extends Error {
  readonly refusal: ListProjectNodeRefusal;

  constructor(refusal: ListProjectNodeRefusal, message: string) {
    super(message);
    this.name = "ListProjectNodeError";
    this.refusal = refusal;
  }
}

export type ListProjectNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  clock: Clock;
  instanceId: string;
  sweepExpiredExternalLeases: (
    transaction: Transaction,
    input: Readonly<{ actor: string; now: number }>,
  ) => void;
}>;

export function listProjectNodes(
  dependencies: ListProjectNodeDependencies,
  input: Readonly<{ projectId: string }>,
): readonly NodeListItem[] {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ListProjectNodeError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    dependencies.sweepExpiredExternalLeases(transaction, {
      actor: dependencies.instanceId,
      now: dependencies.clock.now(),
    });
    const nodes = dependencies.plan.readGraph(
      transaction,
      input.projectId,
    ).nodes;
    return nodes.map(toNodeListItem);
  });
}
