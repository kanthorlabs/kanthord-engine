import {
  externalTransitions,
  externalTriggerIds,
  type ExternalTriggerId,
} from "./external-transition.ts";
import type { NodeKind, NodeState } from "./state.ts";

export const internalTriggerIds = [
  "readiness-promoted",
  "readiness-demoted",
  "claim-taken",
  "ancestor-started",
  "recovery-requeued",
  "recovery-blocked",
  "worker-objective-started",
  "worker-task-started",
  "worker-task-accepted",
  "worker-attempt-limit-reached",
  "run-cancelled-requeued",
  "run-cancelled-abandoned",
  "initiative-aggregated-done",
  "initiative-aggregated-partial",
  "initiative-aggregated-discarded",
  "manual-unblock",
] as const;
export type InternalTriggerId = (typeof internalTriggerIds)[number];
export type NodeTriggerId = ExternalTriggerId | InternalTriggerId;

export type InternalTransition = Readonly<{
  levels: readonly NodeKind[];
  from: NodeState;
  to: NodeState;
  trigger: InternalTriggerId;
}>;

export const internalTransitions: readonly InternalTransition[] = [
  {
    levels: ["initiative", "objective", "task"],
    from: "pending",
    to: "ready",
    trigger: "readiness-promoted",
  },
  {
    levels: ["initiative", "objective", "task"],
    from: "ready",
    to: "pending",
    trigger: "readiness-demoted",
  },
  {
    levels: ["objective", "task"],
    from: "ready",
    to: "running",
    trigger: "claim-taken",
  },
  {
    levels: ["initiative", "objective"],
    from: "ready",
    to: "running",
    trigger: "ancestor-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "recovery-requeued",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "recovery-blocked",
  },
  {
    levels: ["objective"],
    from: "ready",
    to: "running",
    trigger: "worker-objective-started",
  },
  {
    levels: ["task"],
    from: "ready",
    to: "running",
    trigger: "worker-task-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "done",
    trigger: "worker-task-accepted",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "worker-attempt-limit-reached",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "run-cancelled-requeued",
  },
  {
    levels: ["objective"],
    from: "running",
    to: "blocked",
    trigger: "run-cancelled-abandoned",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "done",
    trigger: "initiative-aggregated-done",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "partial",
    trigger: "initiative-aggregated-partial",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "discarded",
    trigger: "initiative-aggregated-discarded",
  },
  {
    levels: ["task"],
    from: "blocked",
    to: "pending",
    trigger: "manual-unblock",
  },
] as const;

export function triggerTransition(
  trigger: NodeTriggerId,
): Readonly<{ levels: readonly NodeKind[]; from: NodeState; to: NodeState }> {
  const internal = internalTransitions.find((row) => row.trigger === trigger);
  if (internal !== undefined) {
    return { levels: internal.levels, from: internal.from, to: internal.to };
  }
  const external = externalTransitions.find((row) => row.trigger === trigger);
  if (external !== undefined) {
    return { levels: [external.level], from: external.from, to: external.to };
  }
  throw new Error(`no transition row for trigger ${trigger}`);
}
