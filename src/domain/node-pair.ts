import { deliverables } from "./deliverable.ts";
import type { Deliverable } from "./deliverable.ts";
import { nodeKinds } from "./state.ts";
import type { NodeKind } from "./state.ts";

export type NodePairLegal = {
  legal: true;
  shape: "parent" | "atomic";
  stateOwner: "aggregate" | "attestation-then-human" | "report";
};

export type NodePairIllegal = {
  legal: false;
  refusal: "pair-illegal";
};

export type NodePairResult = NodePairLegal | NodePairIllegal;

type NodePairTable = {
  [Kind in (typeof nodeKinds)[number]]: {
    [Outcome in (typeof deliverables)[number]]: NodePairResult;
  };
};

const nodePairTable = {
  initiative: {
    test: { legal: false, refusal: "pair-illegal" },
    implementation: { legal: false, refusal: "pair-illegal" },
    review: { legal: false, refusal: "pair-illegal" },
    expansion: { legal: true, shape: "parent", stateOwner: "aggregate" },
  },
  objective: {
    test: {
      legal: true,
      shape: "atomic",
      stateOwner: "attestation-then-human",
    },
    implementation: {
      legal: true,
      shape: "atomic",
      stateOwner: "attestation-then-human",
    },
    review: {
      legal: true,
      shape: "atomic",
      stateOwner: "attestation-then-human",
    },
    expansion: { legal: true, shape: "parent", stateOwner: "aggregate" },
  },
  task: {
    test: { legal: true, shape: "atomic", stateOwner: "report" },
    implementation: { legal: true, shape: "atomic", stateOwner: "report" },
    review: { legal: true, shape: "atomic", stateOwner: "report" },
    expansion: { legal: false, refusal: "pair-illegal" },
  },
} as const satisfies NodePairTable;

export function nodePairLegality(
  kind: NodeKind,
  deliverable: Deliverable,
): NodePairResult {
  return nodePairTable[kind][deliverable];
}
