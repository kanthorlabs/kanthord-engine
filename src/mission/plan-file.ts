import { stringify } from "yaml";
import { NodeKind, type ImportEntry } from "./contract.ts";

export function serializePlanFile(entry: ImportEntry): string {
  const front = stringify({
    ...(entry.id === undefined ? {} : { id: entry.id }),
    kind: entry.kind,
    ...(entry.parent === undefined ? {} : { parent: entry.parent }),
    ...(entry.kind === NodeKind.Task
      ? {}
      : { depends_on: entry.depends_on ?? [] }),
    bindings: entry.bindings,
    verifications: entry.verifications,
  });
  return `---\n${front}---\n# ${entry.name}\n\n## Requirement\n\n${entry.requirement}\n\n## Criterion\n\n${entry.criterion}\n`;
}
