import type { NodeState } from "../../domain/state.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Storage } from "../../services/storage/index.ts";

export type UnblockNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  events: EventLog;
  clock: Clock;
}>;

export type UnblockNodeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export type UnblockNodeResult = Readonly<{
  node: Readonly<{
    id: string;
    state: NodeState;
  }>;
}>;

export type UnblockNodeRefusal =
  | "actor-forbidden"
  | "not-found"
  | "node-kind-invalid"
  | "not-blocked"
  | "block-reason-not-clearable";

export class UnblockNodeError extends Error {
  readonly refusal: UnblockNodeRefusal;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    refusal: UnblockNodeRefusal,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "UnblockNodeError";
    this.refusal = refusal;
    this.details = details;
  }
}

export function unblockNode(
  dependencies: UnblockNodeDependencies,
  input: UnblockNodeInput,
): UnblockNodeResult {
  return dependencies.storage.transact((transaction) => {
    const now = dependencies.clock.now();

    if (input.actorKind === "harness") {
      throw new UnblockNodeError(
        "actor-forbidden",
        "a harness actor cannot unblock a node",
      );
    }

    const node = dependencies.plan.readNode(transaction, input.nodeId);
    if (node === null) {
      throw new UnblockNodeError("not-found", `no node ${input.nodeId}`);
    }
    if (node.kind === "objective" || node.kind === "initiative") {
      throw new UnblockNodeError(
        "node-kind-invalid",
        `a ${node.kind} cannot be unblocked`,
      );
    }
    if (node.state !== "blocked") {
      throw new UnblockNodeError(
        "not-blocked",
        `the task ${node.id} is ${node.state}, not blocked`,
        { state: node.state },
      );
    }
    if (node.blockReason !== "attempt-limit") {
      throw new UnblockNodeError(
        "block-reason-not-clearable",
        `the block reason of task ${node.id} is not attempt-limit`,
        { blockReason: node.blockReason },
      );
    }

    dependencies.events.append(transaction, {
      subjectKind: "node",
      subjectId: node.id,
      type: "node.unblocked",
      actorKind: "human",
      actorId: input.actorId,
      payload: {
        from: "blocked",
        to: "pending",
        clearedReason: "attempt-limit",
      },
    });

    const readiness = dependencies.plan.setNodeState(transaction, {
      id: node.id,
      from: "blocked",
      to: "pending",
      trigger: "manual-unblock",
      blockReason: null,
      at: now,
      cause: { revision: node.revision, importId: null },
    });

    const promoted = readiness.some(
      (transition) =>
        transition.nodeId === node.id && transition.to === "ready",
    );
    return {
      node: {
        id: node.id,
        state: promoted ? "ready" : "pending",
      },
    };
  });
}
