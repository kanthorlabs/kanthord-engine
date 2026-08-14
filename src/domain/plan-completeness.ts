import type { Finding } from "./plan-finding.ts";
import type { NodeKind } from "./state.ts";

export type CompletenessParent = Readonly<{
  kind: NodeKind;
  key: string;
  path: string | null;
  id: string | null;
}>;

export type CompletenessChild = Readonly<{
  kind: NodeKind;
  parentKey: string | null;
}>;

export type CompletenessInput = Readonly<{
  subject: "document" | "record";
  parents: readonly CompletenessParent[];
  children: readonly CompletenessChild[];
}>;

export function completenessFindings(
  input: CompletenessInput,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const parent of input.parents) {
    if (parent.kind === "task") continue;
    const requiredChildKind =
      parent.kind === "initiative" ? "objective" : "task";
    const satisfied = input.children.some(
      (child) =>
        child.kind === requiredChildKind && child.parentKey === parent.key,
    );
    if (satisfied) continue;
    const message =
      input.subject === "document"
        ? `the ${parent.kind} holds no ${requiredChildKind} document`
        : `the ${parent.kind} holds no ${requiredChildKind}`;
    findings.push({
      code:
        parent.kind === "initiative"
          ? "initiative-without-objective"
          : "objective-without-task",
      path: parent.path,
      id: parent.id,
      message,
    });
  }
  return findings;
}
