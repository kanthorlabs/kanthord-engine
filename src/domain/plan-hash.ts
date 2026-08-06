import type { Choice } from "./plan-choice.ts";
import { comparePaths } from "./plan-path.ts";
import type { RenderedDocument } from "./plan-render.ts";

export function canonicalDocumentsJson(
  documents: readonly RenderedDocument[],
): string {
  const sorted = [...documents].sort((left, right) =>
    comparePaths(left.path, right.path),
  );
  return JSON.stringify(sorted.map(({ path, content }) => ({ path, content })));
}

export function canonicalChoicesJson(
  choices: readonly Readonly<{ id: string; take: Choice }>[],
): string {
  const sorted = [...choices].sort((left, right) =>
    comparePaths(left.id, right.id),
  );
  return JSON.stringify(sorted.map(({ id, take }) => ({ id, take })));
}
