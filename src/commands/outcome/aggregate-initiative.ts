import { aggregate } from "../../domain/aggregation.ts";
import { initiativeOutcome } from "../../domain/outcome.ts";
import { terminalStates } from "../../domain/state.ts";
import type { NodeState, TerminalState } from "../../domain/state.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Transaction } from "../../services/storage/index.ts";

export type AggregateInitiativeDependencies = Readonly<{
  plan: PlanStore;
  events: EventLog;
  instanceId: string;
}>;

export type AggregateInitiativeInput = Readonly<{
  initiativeId: string | null;
  at: number;
}>;

export function aggregateInitiative(
  dependencies: AggregateInitiativeDependencies,
  transaction: Transaction,
  input: AggregateInitiativeInput,
): void {
  if (input.initiativeId === null) {
    return;
  }

  const node = dependencies.plan.readNode(transaction, input.initiativeId);
  if (node === null || node.state !== "running") {
    return;
  }

  const objectives = dependencies.plan
    .readAllNodes(transaction)
    .filter((candidate) => candidate.parentId === node.id)
    .sort((left, right) => compareIds(left.id, right.id));
  const states = objectives.map((objective) => objective.state);
  const everyTerminal = states.every((state) =>
    (terminalStates as readonly NodeState[]).includes(state),
  );
  if (!everyTerminal) {
    return;
  }
  if (states.length === 0) {
    throw new Error(`the initiative ${node.id} holds no objective`);
  }

  const projected = aggregate("initiative", states as readonly TerminalState[]);
  const outcome = initiativeOutcome(projected, "not-applicable");
  const trigger =
    outcome.state === "done"
      ? "initiative-aggregated-done"
      : outcome.state === "partial"
        ? "initiative-aggregated-partial"
        : "initiative-aggregated-discarded";

  dependencies.plan.setNodeState(transaction, {
    id: node.id,
    from: "running",
    to: outcome.state,
    trigger,
    blockReason: outcome.blockReason,
    at: input.at,
    cause: { revision: node.revision, importId: null },
  });

  dependencies.events.append(transaction, {
    subjectKind: "node",
    subjectId: node.id,
    type:
      outcome.state === "done"
        ? "node.done"
        : outcome.state === "partial"
          ? "node.partial"
          : "node.discarded",
    actorKind: "daemon",
    actorId: dependencies.instanceId,
    payload: {
      from: "running",
      to: outcome.state,
      reason: "objectives-terminal",
      objectiveStates: states,
    },
  });
}

function compareIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
