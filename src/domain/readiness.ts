import type { NodeTriggerId } from "./node-trigger.ts";
import type { StoredEdge } from "./plan-graph.ts";
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

export type ReadinessNode = Readonly<{
  id: string;
  state: NodeState;
}>;

export type ReadinessTransition = Readonly<{
  nodeId: string;
  from: NodeState;
  to: NodeState;
  trigger: NodeTriggerId;
}>;

export function deriveReadiness(
  nodes: readonly ReadinessNode[],
  edges: readonly StoredEdge[],
): readonly ReadinessTransition[] {
  const stateById = new Map(nodes.map((node) => [node.id, node.state]));
  const dependenciesByNode = new Map<string, Dependency[]>();
  for (const edge of edges) {
    const state = stateById.get(edge.toNode);
    if (state === undefined) {
      continue;
    }
    const dependencies = dependenciesByNode.get(edge.fromNode) ?? [];
    dependencies.push({ state, waived: edge.waivedAt !== null });
    dependenciesByNode.set(edge.fromNode, dependencies);
  }
  const transitions: ReadinessTransition[] = [];
  for (const node of nodes) {
    const ready = isReady(dependenciesByNode.get(node.id) ?? []);
    if (node.state === "pending" && ready) {
      transitions.push({
        nodeId: node.id,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      });
    } else if (node.state === "ready" && !ready) {
      transitions.push({
        nodeId: node.id,
        from: "ready",
        to: "pending",
        trigger: "readiness-demoted",
      });
    }
  }
  return transitions.sort((left, right) =>
    Buffer.compare(
      Buffer.from(left.nodeId, "utf8"),
      Buffer.from(right.nodeId, "utf8"),
    ),
  );
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
