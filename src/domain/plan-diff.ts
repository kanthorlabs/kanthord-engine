import type { DifferingField } from "./plan-choice.ts";
import type { StoredNode } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";
import { comparePaths } from "./plan-path.ts";

export function differingFields(
  stored: StoredNode,
  submitted: ResolvedDocument,
  blobs: Readonly<{ instruction: string; acceptance: string | null }>,
): readonly DifferingField[] {
  const fields: DifferingField[] = [];
  if (stored.title !== submitted.title) {
    fields.push("title");
  }
  if (
    blobs.instruction !== stored.instructionBlob ||
    blobs.acceptance !== stored.acceptanceBlob
  ) {
    fields.push("body");
  }
  if (
    !equalIdentities(
      normalized(stored.dependencies),
      normalized(submitted.dependencies),
    )
  ) {
    fields.push("depends_on");
  }
  if (stored.worker !== submitted.worker) {
    fields.push("worker");
  }
  if (stored.repositoryId !== submitted.repo) {
    fields.push("repo");
  }
  if (stored.parentId !== submitted.parentIdentity) {
    fields.push("parent");
  }
  return [...fields].sort(comparePaths);
}

function normalized(identities: readonly string[]): string[] {
  const sorted = [...identities].sort(comparePaths);
  const result: string[] = [];
  for (const identity of sorted) {
    if (result[result.length - 1] !== identity) {
      result.push(identity);
    }
  }
  return result;
}

function equalIdentities(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
