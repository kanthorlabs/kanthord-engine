import type { ContainmentFacts } from "./plan-graph.ts";
import type { NodeKind } from "./state.ts";

export function containmentMovable(
  kind: NodeKind,
  facts: ContainmentFacts,
): boolean {
  return (
    !facts.lease &&
    !facts.workspace &&
    !facts.attemptCommit &&
    !facts.retainedCommit
  );
}
