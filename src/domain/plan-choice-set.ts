import type { Choice } from "./plan-choice.ts";
import { comparePaths } from "./plan-path.ts";

export type ChoiceSetErrorCode =
  "choice-duplicate" | "choice-missing" | "choice-extra";

export class ChoiceSetError extends Error {
  readonly code: ChoiceSetErrorCode;
  readonly ids: readonly string[];

  constructor(code: ChoiceSetErrorCode, ids: readonly string[]) {
    super(`${code}: ${ids.join(", ")}`);
    this.name = "ChoiceSetError";
    this.code = code;
    this.ids = ids;
  }
}

export function assertChoiceSet(
  input: Readonly<{
    choices: readonly Readonly<{ id: string; take: Choice }>[];
    required: readonly string[];
  }>,
): ReadonlyMap<string, Choice> {
  const { choices, required } = input;

  const takes = new Map<string, Choice>();
  const duplicates = new Set<string>();
  for (const entry of choices) {
    if (takes.has(entry.id)) {
      duplicates.add(entry.id);
    } else {
      takes.set(entry.id, entry.take);
    }
  }
  if (duplicates.size > 0) {
    throw new ChoiceSetError(
      "choice-duplicate",
      [...duplicates].sort(comparePaths),
    );
  }

  const missing = required.filter((id) => !takes.has(id)).sort(comparePaths);
  if (missing.length > 0) {
    throw new ChoiceSetError("choice-missing", missing);
  }

  const extra = [...takes.keys()]
    .filter((id) => !required.includes(id))
    .sort(comparePaths);
  if (extra.length > 0) {
    throw new ChoiceSetError("choice-extra", extra);
  }

  return takes;
}
