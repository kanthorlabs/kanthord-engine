import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { planFrontmatter } from "./plan-document.ts";

function issuePaths(
  result: ReturnType<typeof planFrontmatter.safeParse>,
): readonly (readonly PropertyKey[])[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path);
}

describe("src/domain/plan-document.test", () => {
  it("planFrontmatter accepts the legacy shape (worker only)", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "T",
      worker: "claude.swe@1",
    });
    assert.equal(result.success, true);
    if (result.success) {
      const data = result.data as typeof result.data & {
        deliverable?: unknown;
        verify?: unknown;
      };
      assert.equal(data.deliverable, undefined);
      assert.equal(data.verify, undefined);
    }
  });

  it("planFrontmatter accepts the new shape (deliverable and verify)", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "T",
      deliverable: "test",
      verify: { paths: [], commands: [] },
    });
    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.worker, undefined);
    }
  });

  it("both worker and deliverable together raise frontmatter-invalid on path deliverable", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "T",
      worker: "claude.swe@1",
      deliverable: "test",
      verify: { paths: [], commands: [] },
    });
    assert.equal(result.success, false);
    const paths = issuePaths(result);
    assert.equal(
      paths.filter(
        (path) => JSON.stringify(path) === JSON.stringify(["deliverable"]),
      ).length,
      1,
    );
    assert.deepEqual(
      paths.find(
        (path) => JSON.stringify(path) === JSON.stringify(["deliverable"]),
      ),
      ["deliverable"],
    );
    if (!result.success) {
      const issue = result.error.issues.find(
        (entry) =>
          JSON.stringify(entry.path) === JSON.stringify(["deliverable"]),
      );
      assert.equal(issue?.message, "frontmatter-invalid");
    }
  });

  it("a document naming neither worker nor deliverable parses for every kind", () => {
    for (const kind of ["initiative", "objective", "task"] as const) {
      const result = planFrontmatter.safeParse({ kind, title: "T" });
      assert.equal(result.success, true, kind);
      if (result.success) {
        assert.equal(result.data.worker, undefined, kind);
        assert.equal(result.data.deliverable, undefined, kind);
      }
    }
  });

  it("deliverable with no verify raises frontmatter-invalid on path verify", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "T",
      deliverable: "test",
    });
    assert.equal(result.success, false);
    const paths = issuePaths(result);
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0], ["verify"]);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.message, "frontmatter-invalid");
    }
  });

  it("an assignment key raises unknown frontmatter key on path assignment", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "T",
      worker: "claude.swe@1",
      assignment: "x",
    });
    assert.equal(result.success, false);
    const paths = issuePaths(result);
    assert.deepEqual(paths, [["assignment"]]);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.message, "unknown frontmatter key");
    }
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
      worker: "claude.swe@1",
      status: "done",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["status"]]);
  });

  it("kind epic is refused with the issue path kind", () => {
    const result = planFrontmatter.safeParse({
      kind: "epic",
      title: "Ship",
      worker: "claude.swe@1",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["kind"]]);
  });

  it("an empty title is refused with the issue path title", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "",
      worker: "claude.swe@1",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["title"]]);
  });

  it("an empty depends_on list parses", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      depends_on: [],
      worker: "claude.swe@1",
    });
    assert.equal(result.success, true);
  });

  it("an empty depends_on entry is refused with the issue path depends_on.0", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      depends_on: [""],
      worker: "claude.swe@1",
    });
    assert.equal(result.success, false);
    assert.deepEqual(issuePaths(result), [["depends_on", 0]]);
  });

  it("worker nope@9 is refused with the issue path worker", () => {
    const result = planFrontmatter.safeParse({
      kind: "task",
      title: "Ship",
      worker: "nope@9",
      deliverable: "test",
      verify: { paths: [], commands: [] },
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
        deliverable: "test",
        verify: { paths: [], commands: [] },
      });
      assert.equal(result.success, false);
      assert.deepEqual(issuePaths(result), [["worker"]]);
    });
  }
});
