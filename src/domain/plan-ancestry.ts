import type { NodeState } from "./state.ts";
import { terminalStates } from "./state.ts";

export type AncestryNode = Readonly<{
  id: string;
  parentId: string | null;
  state: NodeState;
}>;

export function terminalAncestor(
  nodes: readonly AncestryNode[],
  parentId: string | null,
): AncestryNode | null {
  const index = new Map(nodes.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  let current = parentId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    const parent = index.get(current);
    if (parent === undefined) {
      return null;
    }
    if (terminalStates.some((terminal) => terminal === parent.state)) {
      return parent;
    }
    current = parent.parentId;
  }
  return null;
}
