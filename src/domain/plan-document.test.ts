import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planFrontmatter } from "./plan-document.ts";

function issuePaths(
  result: ReturnType<typeof planFrontmatter.safeParse>,
): readonly (readonly PropertyKey[])[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

describe("src/domain/plan-document.test", () => {
  it("planFrontmatter accepts the minimal task frontmatter", () => {
    assert.equal(
      planFrontmatter.safeParse({ kind: "task", title: "Ship" }).success,
      true,
    );
  });

  it("planFrontmatter accepts the full objective frontmatter", () => {
    const result = planFrontmatter.safeParse({
      id: "objective_01ARZ3NDEKTSV4RRFFQ69G5FAA",
      kind: "objective",
      title: "Harden the verify CLI",
      depends_on: ["plan/i--01/initiative.md"],
      worker: "tdd@1",
      repo: "repo_a",
    });
    assert.equal(result.success, true);
  });

  it("an unknown status key is refused with the issue path status", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      status: "done",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["status"]]);
  });

  it("kind epic is refused with the issue path kind", () => {
    const result = planFrontmatter.safeParse({ kind: "epic", title: "Ship" });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["kind"]]);
  });

  it("an empty title is refused with the issue path title", () => {
    const result = planFrontmatter.safeParse({ kind: "task", title: "" });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["title"]]);
  });

  it("an empty depends_on list parses", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      depends_on: [],
    });
    assert.equal(result.success, true);
  });

  it("an empty depends_on entry is refused with the issue path depends_on.0", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      depends_on: [""],
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["depends_on", 0]]);
  });

  it("worker nope@9 is refused with the issue path worker", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      worker: "nope@9",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["worker"]]);
  });

  for (const harnessKind of [
    "claude.swe@1",
    "claude.te@1",
    "opencode.swe@1",
    "opencode.te@1",
  ] as const) {
    it(`worker ${harnessKind} parses`, () => {
      const result = planFrontmatter.safeParse({
        kind: "task",
        title: "Ship",
        worker: harnessKind,
      });
      assert.equal(result.success, true);
    });
  }

  for (const agentName of ["swe@1", "te@1"] as const) {
    it(`worker ${agentName} is refused with the issue path worker`, () => {
      const result = planFrontmatter.safeParse({
        kind: "task",
        title: "Ship",
        worker: agentName,
      });
      assert.equal(result.success, false);
      assert.deepEqual(issuePaths(result), [["worker"]]);
    });
  }
});
