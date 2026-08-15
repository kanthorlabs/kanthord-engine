import type { NodeState } from "./state.ts";

export const nodeWriteRefusals = ["state", "containment"] as const;
export type NodeWriteRefusal = (typeof nodeWriteRefusals)[number];

export const proseFields = ["body", "title"] as const;
export const structuralFields = [
  "depends_on",
  "parent",
  "repo",
  "worker",
] as const;

export const differingFields = [
  "body",
  "depends_on",
  "parent",
  "repo",
  "title",
  "worker",
] as const;
export type DifferingField = (typeof differingFields)[number];

export type NodeWriteFacts = Readonly<{
  state: NodeState;
  fields: readonly DifferingField[];
  containmentMovable: boolean;
}>;

export type NodeWriteLegality =
  | Readonly<{ legal: true }>
  | Readonly<{ legal: false; refusal: NodeWriteRefusal }>;

export function nodeWriteLegality(facts: NodeWriteFacts): NodeWriteLegality {
  const structural = facts.fields.some((field) =>
    (structuralFields as readonly string[]).includes(field),
  );

  if (!structural) {
    return { legal: true };
  }

  if (
    facts.state !== "pending" &&
    facts.state !== "ready" &&
    facts.state !== "blocked"
  ) {
    return { legal: false, refusal: "state" };
  }

  if (
    (facts.fields.includes("parent") || facts.fields.includes("repo")) &&
    !facts.containmentMovable
  ) {
    return { legal: false, refusal: "containment" };
  }

  return { legal: true };
}
