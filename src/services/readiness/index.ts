import type { Transaction } from "../storage/index.ts";
import type {
  ReadinessNode,
  ReadinessTransition,
} from "../../domain/readiness.ts";
import type { StoredEdge } from "../../domain/plan-graph.ts";

export type ReadinessCause = Readonly<{
  revision: string;
  importId: string | null;
}>;

export type ReadinessInput = Readonly<{
  projectId: string;
  nodes: readonly ReadinessNode[];
  edges: readonly StoredEdge[];
  focusNodeId?: string;
  at: number;
  cause: ReadinessCause;
}>;

export interface Readiness {
  apply(
    transaction: Transaction,
    input: ReadinessInput,
  ): readonly ReadinessTransition[];
}

export type { ReadinessTransition };
