import type { Deliverable } from "./deliverable.ts";

export const runKinds = ["structural", "execution", "review"] as const;
export type RunKind = (typeof runKinds)[number];

const runKindByDeliverable: Readonly<Record<Deliverable, RunKind>> = {
  expansion: "structural",
  implementation: "execution",
  review: "review",
  test: "execution",
};

export function runKindFor(deliverable: Deliverable): RunKind {
  return runKindByDeliverable[deliverable];
}
