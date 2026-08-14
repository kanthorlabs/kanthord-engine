export const nodeWriteKinds = [
  "create",
  "update-fields",
  "update-topology",
  "delete",
] as const;
export type NodeWriteKind = (typeof nodeWriteKinds)[number];

export const revisionGuardClasses = ["node", "project"] as const;
export type RevisionGuardClass = (typeof revisionGuardClasses)[number];

export function revisionGuardFor(kind: NodeWriteKind): RevisionGuardClass {
  return kind === "update-fields" ? "node" : "project";
}
