import type { NodeState } from "./state.ts";

export const choices = ["submitted", "database"] as const;
export type Choice = (typeof choices)[number];

export type DifferingField =
  "title" | "body" | "depends_on" | "worker" | "repo" | "parent";

export const proseFields = ["body", "title"] as const;
export const structuralFields = [
  "depends_on",
  "parent",
  "repo",
  "worker",
] as const;

export type Presence = "both" | "document-only" | "database-only";

export type ChoiceFacts = Readonly<{
  presence: Presence;
  state: NodeState | null;
  fields: readonly DifferingField[];
  containmentMovable: boolean;
}>;

export type ChoiceLegality = Readonly<{
  legal: boolean;
  reason: string | null;
}>;

export type ChoiceVerdict = Readonly<{
  suggested: Choice;
  submitted: ChoiceLegality;
  database: ChoiceLegality;
}>;

export function choiceVerdict(facts: ChoiceFacts): ChoiceVerdict {
  const database: ChoiceLegality = { legal: true, reason: null };

  if (facts.presence === "database-only") {
    return {
      suggested: "database",
      submitted: { legal: false, reason: "a deletion is node.discard" },
      database,
    };
  }

  if (facts.presence === "document-only") {
    return {
      suggested: "submitted",
      submitted: { legal: true, reason: null },
      database: { legal: true, reason: "do not create it" },
    };
  }

  if (facts.fields.length === 0) {
    return {
      suggested: "database",
      submitted: { legal: true, reason: "equivalent" },
      database,
    };
  }

  const hasStructural = facts.fields.some((field) =>
    (structuralFields as readonly string[]).includes(field),
  );

  if (!hasStructural) {
    const suggested: Choice =
      facts.state === "pending" ||
      facts.state === "blocked" ||
      facts.state === "ready"
        ? "submitted"
        : "database";
    return { suggested, submitted: { legal: true, reason: null }, database };
  }

  const structuralLegal =
    !facts.fields.includes("parent") && !facts.fields.includes("repo")
      ? true
      : facts.containmentMovable;

  if (facts.state === "pending" || facts.state === "blocked") {
    return {
      suggested: structuralLegal ? "submitted" : "database",
      submitted: structuralLegal
        ? { legal: true, reason: null }
        : {
            legal: false,
            reason:
              "the node or a descendant holds a lease, a workspace or a commit",
          },
      database,
    };
  }

  return {
    suggested: "database",
    submitted: {
      legal: false,
      reason: "a structural edit needs pending or blocked",
    },
    database,
  };
}
