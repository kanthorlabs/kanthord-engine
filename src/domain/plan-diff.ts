import type { DifferingField } from "./plan-choice.ts";
import type { StoredNode } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";
import { comparePaths } from "./plan-path.ts";

export type ChoiceBody = Readonly<{
  instructionBlob: string;
  acceptanceBlob: string | null;
}>;

export type ChoiceValues = Readonly<{
  body?: ChoiceBody;
  depends_on?: readonly string[];
  parent?: string | null;
  repo?: string | null;
  title?: string;
  worker?: string | null;
}>;

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

function selects(
  fields: readonly DifferingField[] | null,
  name: DifferingField,
): boolean {
  return fields === null || fields.includes(name);
}

export function storedValues(
  stored: StoredNode,
  fields: readonly DifferingField[] | null,
): ChoiceValues {
  const values: {
    body?: ChoiceBody;
    depends_on?: readonly string[];
    parent?: string | null;
    repo?: string | null;
    title?: string;
    worker?: string | null;
  } = {};
  if (selects(fields, "body")) {
    values.body = {
      instructionBlob: stored.instructionBlob,
      acceptanceBlob: stored.acceptanceBlob,
    };
  }
  if (selects(fields, "depends_on")) {
    values.depends_on = normalized(stored.dependencies);
  }
  if (selects(fields, "parent")) {
    values.parent = stored.parentId;
  }
  if (selects(fields, "repo")) {
    values.repo = stored.repositoryId;
  }
  if (selects(fields, "title")) {
    values.title = stored.title;
  }
  if (selects(fields, "worker")) {
    values.worker = stored.worker;
  }
  return values;
}

export function submittedValues(
  submitted: ResolvedDocument,
  blobs: Readonly<{ instruction: string; acceptance: string | null }>,
  fields: readonly DifferingField[] | null,
): ChoiceValues {
  const values: {
    body?: ChoiceBody;
    depends_on?: readonly string[];
    parent?: string | null;
    repo?: string | null;
    title?: string;
    worker?: string | null;
  } = {};
  if (selects(fields, "body")) {
    values.body = {
      instructionBlob: blobs.instruction,
      acceptanceBlob: blobs.acceptance,
    };
  }
  if (selects(fields, "depends_on")) {
    values.depends_on = normalized(submitted.dependencies);
  }
  if (selects(fields, "parent")) {
    values.parent = submitted.parentIdentity;
  }
  if (selects(fields, "repo")) {
    values.repo = submitted.repo;
  }
  if (selects(fields, "title")) {
    values.title = submitted.title;
  }
  if (selects(fields, "worker")) {
    values.worker = submitted.worker;
  }
  return values;
}
