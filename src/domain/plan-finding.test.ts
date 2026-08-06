import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findingCodes, sortFindings, type Finding } from "./plan-finding.ts";

const expectedCodes: readonly string[] = [
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
  "parent-missing",
  "path-duplicate",
  "path-invalid",
  "reference-ambiguous",
  "reference-unresolved",
  "repo-missing",
  "repo-on-task",
  "repository-unbound",
  "repository-unknown",
  "worker-unknown",
];

describe("src/domain/plan-finding.test", () => {
  it("findingCodes pins the twenty-four codes in bytewise order", () => {
    assert.equal(findingCodes.length, 24);
    assert.deepEqual([...findingCodes], expectedCodes);
    assert.deepEqual([...findingCodes], [...findingCodes].sort());
    assert.equal(new Set(findingCodes).size, 24);
  });

  it("sortFindings orders by path with null first, then code, then id", () => {
    const findings: readonly Finding[] = [
      { code: "repo-missing", path: "plan/a.md", id: null, message: "m" },
      { code: "path-invalid", path: "plan/a.md", id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: "task_1", message: "m" },
      { code: "path-invalid", path: null, id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: null, message: "m" },
    ];
    const expected: readonly Finding[] = [
      { code: "path-invalid", path: null, id: null, message: "m" },
      { code: "path-invalid", path: "plan/a.md", id: null, message: "m" },
      { code: "repo-missing", path: "plan/a.md", id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: "task_1", message: "m" },
    ];
    assert.deepEqual(sortFindings(findings), expected);
  });

  it("sortFindings is stable across two calls and does not mutate its input", () => {
    const shuffled: readonly Finding[] = [
      { code: "repo-missing", path: "plan/a.md", id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: "task_1", message: "m" },
      { code: "path-invalid", path: null, id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: null, message: "m" },
      { code: "path-invalid", path: "plan/a.md", id: null, message: "m" },
    ];
    const first = sortFindings(shuffled);
    assert.deepEqual(sortFindings(shuffled), first);
    assert.deepEqual([...shuffled], shuffled);
  });
});
