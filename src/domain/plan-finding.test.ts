import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  findingCodes,
  findingScope,
  sortFindings,
  validationScopes,
  type Finding,
} from "./plan-finding.ts";

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
];

describe("src/domain/plan-finding.test", () => {
  it("findingCodes pins the twenty-six codes in bytewise order", () => {
    assert.equal(findingCodes.length, 26);
    assert.deepEqual([...findingCodes], expectedCodes);
    assert.deepEqual([...findingCodes], [...findingCodes].sort());
    assert.equal(new Set(findingCodes).size, 26);
  });

  it("validationScopes pins the two scopes in order", () => {
    assert.equal(validationScopes.length, 2);
    assert.deepEqual([...validationScopes], ["structural", "completeness"]);
  });

  it("findingScope is total over findingCodes", () => {
    const keys = Object.keys(findingScope);
    assert.equal(keys.length, 26);
    for (const code of findingCodes) {
      assert.ok(code in findingScope, `findingScope holds ${code}`);
    }
    for (const key of keys) {
      assert.ok(
        (findingCodes as readonly string[]).includes(key),
        `${key} is a finding code`,
      );
    }
  });

  it("the completeness scope holds exactly the two completeness codes", () => {
    const completenessCodes = findingCodes.filter(
      (code) => findingScope[code] === "completeness",
    );
    assert.deepEqual(completenessCodes, [
      "initiative-without-objective",
      "objective-without-task",
    ]);
  });

  it("sortFindings orders by path with null first, then code, then id", () => {
    const findings: readonly Finding[] = [
      { code: "repo-missing", path: "plan/a.md", id: null, message: "m" },
      { code: "path-invalid", path: "plan/a.md", id: null, message: "m" },
      { code: "pair-illegal", path: "plan/a.md", id: null, message: "m" },
      { code: "verify-invalid", path: "plan/a.md", id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: "task_1", message: "m" },
      { code: "path-invalid", path: null, id: null, message: "m" },
      { code: "worker-unknown", path: "plan/b.md", id: null, message: "m" },
    ];
    const expected: readonly Finding[] = [
      { code: "path-invalid", path: null, id: null, message: "m" },
      { code: "pair-illegal", path: "plan/a.md", id: null, message: "m" },
      { code: "path-invalid", path: "plan/a.md", id: null, message: "m" },
      { code: "repo-missing", path: "plan/a.md", id: null, message: "m" },
      { code: "verify-invalid", path: "plan/a.md", id: null, message: "m" },
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
