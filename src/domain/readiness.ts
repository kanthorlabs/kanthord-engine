import type { BlockReason, NodeState } from "./state.ts";

export type Dependency = Readonly<{
  state: NodeState;
  waived: boolean;
}>;

export function satisfiesDependency(state: NodeState): boolean {
  return state === "done" || state === "partial";
}

export function isReady(dependencies: readonly Dependency[]): boolean {
  return dependencies.every((d) => d.waived || satisfiesDependency(d.state));
}

export type Clearance = "unblock" | "waive" | "import";

export const blockReasonClearance: Readonly<
  Record<BlockReason, readonly Clearance[]>
> = {
  "attempt-limit": ["unblock"],
  "dependency-discarded": ["waive", "import"],
  "stale-base": ["unblock"],
  "dirty-recovery": ["unblock"],
  "e2e-failed": ["import"],
  abandoned: ["unblock"],
};

export function clearedByUnblock(reason: BlockReason): boolean {
  return blockReasonClearance[reason].includes("unblock");
}
