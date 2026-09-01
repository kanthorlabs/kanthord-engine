import { comparePaths } from "./plan-path.ts";

export const validationScopes = ["structural", "completeness"] as const;
export type ValidationScope = (typeof validationScopes)[number];

export const findingCodes = [
  "acceptance-heading-duplicated",
  "acceptance-heading-not-at-line-start",
  "acceptance-missing",
  "acceptance-unexpected",
  "dependency-cross-parent",
  "dependency-cycle",
  "dependency-self",
  "document-unparsable",
  "frontmatter-invalid",
  "identity-duplicate",
  "identity-invalid",
  "identity-kind-mismatch",
  "initiative-without-objective",
  "objective-without-task",
  "pair-illegal",
  "parent-missing",
  "path-duplicate",
  "path-invalid",
  "reference-ambiguous",
  "reference-unresolved",
  "repo-missing",
  "repo-on-task",
  "repository-unbound",
  "repository-unknown",
  "verify-invalid",
  "worker-unknown",
] as const;

export type FindingCode = (typeof findingCodes)[number];

export type Finding = Readonly<{
  code: FindingCode;
  path: string | null;
  id: string | null;
  message: string;
}>;

export const findingScope: Readonly<Record<FindingCode, ValidationScope>> = {
  "acceptance-heading-duplicated": "structural",
  "acceptance-heading-not-at-line-start": "structural",
  "acceptance-missing": "structural",
  "acceptance-unexpected": "structural",
  "dependency-cross-parent": "structural",
  "dependency-cycle": "structural",
  "dependency-self": "structural",
  "document-unparsable": "structural",
  "frontmatter-invalid": "structural",
  "identity-duplicate": "structural",
  "identity-invalid": "structural",
  "identity-kind-mismatch": "structural",
  "initiative-without-objective": "completeness",
  "objective-without-task": "completeness",
  "pair-illegal": "structural",
  "parent-missing": "structural",
  "path-duplicate": "structural",
  "path-invalid": "structural",
  "reference-ambiguous": "structural",
  "reference-unresolved": "structural",
  "repo-missing": "structural",
  "repo-on-task": "structural",
  "repository-unbound": "structural",
  "repository-unknown": "structural",
  "verify-invalid": "structural",
  "worker-unknown": "structural",
};

export function sortFindings(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((left, right) => {
    const byPath = comparePathKeys(left.path, right.path);
    if (byPath !== 0) return byPath;
    if (left.code !== right.code) return left.code < right.code ? -1 : 1;
    if (left.id === null && right.id === null) return 0;
    if (left.id === null) return -1;
    if (right.id === null) return 1;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  });
}

function comparePathKeys(left: string | null, right: string | null): number {
  if (left === null && right === null) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return comparePaths(left, right);
}
