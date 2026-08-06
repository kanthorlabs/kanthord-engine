import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SubmittedPathError,
  comparePaths,
  derivedParentPath,
  parseSubmittedPath,
  resolveRelativePath,
} from "./plan-path.ts";
import type {
  SubmittedPathErrorCode,
  SubmittedPathShape,
} from "./plan-path.ts";

const nineCodes: readonly (readonly [
  path: string,
  code: SubmittedPathErrorCode,
])[] = [
  ["\uD800plan/a--01/initiative.md", "path-not-scalar"],
  ["plan/a--01/initiative.md\u0000", "path-nul"],
  ["plan\\a--01/initiative.md", "path-backslash"],
  ["/plan/a--01/initiative.md", "path-absolute"],
  ["plan//a--01/initiative.md", "path-empty-segment"],
  ["plan/a--01/../a--01/initiative.md", "path-dot-segment"],
  ["docs/plan/a--01/initiative.md", "path-not-under-plan"],
  ["plan/a--01/initiative.MD", "path-not-markdown"],
  ["plan/a--01/objective.md", "path-kind-mismatch"],
];

describe("src/domain/plan-path.test", () => {
  it("parses the three legal shapes with the exact shape", () => {
    const initiative: SubmittedPathShape = {
      kind: "initiative",
      initiativeDirectory: "a--01",
      objectiveDirectory: null,
    };
    const objective: SubmittedPathShape = {
      kind: "objective",
      initiativeDirectory: "a--01",
      objectiveDirectory: "b--02",
    };
    const task: SubmittedPathShape = {
      kind: "task",
      initiativeDirectory: "a--01",
      objectiveDirectory: "b--02",
    };
    assert.deepEqual(
      parseSubmittedPath("plan/a--01/initiative.md"),
      initiative,
    );
    assert.deepEqual(
      parseSubmittedPath("plan/a--01/b--02/objective.md"),
      objective,
    );
    assert.deepEqual(parseSubmittedPath("plan/a--01/b--02/01-c--03.md"), task);
  });

  it("throws path-kind-mismatch for five segment layouts", () => {
    for (const path of [
      "plan/a--01/b--02/initiative.md",
      "plan/a--01/objective.md",
      "plan/initiative.md",
      "plan/a--01/b--02/c--03/objective.md",
      "plan/a--01/b--02/c--03/04-d.md",
    ]) {
      assert.throws(
        () => parseSubmittedPath(path),
        (err) =>
          err instanceof SubmittedPathError &&
          err.code === "path-kind-mismatch",
        `expected path-kind-mismatch for ${JSON.stringify(path)}`,
      );
    }
  });

  it("throws each of the nine codes from its own named path", () => {
    for (const [path, code] of nineCodes) {
      assert.throws(
        () => parseSubmittedPath(path),
        (err) => err instanceof SubmittedPathError && err.code === code,
        `expected ${code} for ${JSON.stringify(path)}`,
      );
    }
  });

  it("the check order is pinned on one degrading input", () => {
    const degrading: readonly (readonly [
      path: string,
      code: SubmittedPathErrorCode,
    ])[] = [
      ["\uD800plan/a//b\\c.md\u0000", "path-not-scalar"],
      ["plan/a//b\\c.md\u0000", "path-nul"],
      ["plan/a//b\\c.md", "path-backslash"],
      ["plan/a//b/c.md", "path-empty-segment"],
    ];
    for (const [path, code] of degrading) {
      assert.throws(
        () => parseSubmittedPath(path),
        (err) => err instanceof SubmittedPathError && err.code === code,
        `expected ${code} for ${JSON.stringify(path)}`,
      );
    }
  });

  it("refuses an unpaired surrogate and parses a correctly paired emoji", () => {
    assert.throws(
      () => parseSubmittedPath("plan/\uD800--01/initiative.md"),
      (err) =>
        err instanceof SubmittedPathError && err.code === "path-not-scalar",
    );
    assert.throws(
      () => parseSubmittedPath("plan/\uDFFF--01/initiative.md"),
      (err) =>
        err instanceof SubmittedPathError && err.code === "path-not-scalar",
    );
    assert.deepEqual(parseSubmittedPath("plan/\u{1F600}--01/initiative.md"), {
      kind: "initiative",
      initiativeDirectory: "\u{1F600}--01",
      objectiveDirectory: null,
    });
  });

  it("is case-sensitive — Plan/x/initiative.md is path-not-under-plan", () => {
    assert.throws(
      () => parseSubmittedPath("Plan/x/initiative.md"),
      (err) =>
        err instanceof SubmittedPathError && err.code === "path-not-under-plan",
    );
  });

  it("derivedParentPath returns null for an initiative and the parent path for an objective and a task", () => {
    assert.equal(derivedParentPath("plan/a--01/initiative.md"), null);
    assert.equal(
      derivedParentPath("plan/a--01/b--02/objective.md"),
      "plan/a--01/initiative.md",
    );
    assert.equal(
      derivedParentPath("plan/a--01/b--02/01-c--03.md"),
      "plan/a--01/b--02/objective.md",
    );
  });

  it("two objectives under one initiative derive the same parent path", () => {
    assert.equal(
      derivedParentPath("plan/a--01/b--02/objective.md"),
      derivedParentPath("plan/a--01/c--03/objective.md"),
    );
  });

  it("moving a task between objective directories changes the derived parent but renaming its file does not", () => {
    const original = derivedParentPath("plan/a--01/b--02/01-c--03.md");
    assert.equal(derivedParentPath("plan/a--01/b--02/02-d--04.md"), original);
    assert.notEqual(
      derivedParentPath("plan/a--01/d--04/01-c--03.md"),
      original,
    );
  });

  it("comparePaths matches Buffer.compare over a table that includes an above-the-BMP pair", () => {
    // An unpaired surrogate is out of scope here: check 0 of parseSubmittedPath
    // refuses it, so no value reaching comparePaths can hit the disagreement
    // between code-point order and the U+FFFD encoding of a lone surrogate.
    const pairs: readonly (readonly [string, string])[] = [
      ["plan/é.md", "plan/z.md"],
      ["plan/z.md", "plan/é.md"],
      ["plan/ü.md", "plan/v.md"],
      ["plan/v.md", "plan/ü.md"],
      ["plan/\u{1F600}.md", "plan/\uFFFD.md"],
      ["plan/\uFFFD.md", "plan/\u{1F600}.md"],
      ["plan/a--01/initiative.md", "plan/a--02/initiative.md"],
      ["plan/a--01/initiative.md", "plan/a--01/initiative.md"],
    ];
    for (const [left, right] of pairs) {
      assert.equal(
        Math.sign(comparePaths(left, right)),
        Math.sign(
          Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
        ),
        `sign mismatch for ${JSON.stringify(left)} vs ${JSON.stringify(right)}`,
      );
    }
  });

  it("comparePaths puts z before é where the named locale puts é first", () => {
    const accented = "plan/é.md";
    const plain = "plan/z.md";
    assert.ok(comparePaths(accented, plain) > 0);
    assert.ok(accented.localeCompare(plain, "en") < 0);
  });

  it("resolveRelativePath joins a sibling basename to the from directory", () => {
    assert.equal(
      resolveRelativePath("plan/a--01/b--02", "01-c--03.md"),
      "plan/a--01/b--02/01-c--03.md",
    );
  });

  it("resolveRelativePath pops one parent segment per double dot", () => {
    assert.equal(
      resolveRelativePath("plan/a--01/b--02", "../c--04/objective.md"),
      "plan/a--01/c--04/objective.md",
    );
  });

  it("resolveRelativePath drops a dot segment", () => {
    assert.equal(
      resolveRelativePath("plan/a--01/b--02", "./x.md"),
      "plan/a--01/b--02/x.md",
    );
  });

  it("resolveRelativePath returns null when a parent pop escapes the first segment", () => {
    assert.equal(resolveRelativePath("plan", "../x.md"), null);
  });

  it("resolveRelativePath never guesses a root", () => {
    assert.equal(
      resolveRelativePath("plan/a--01", "plan/a--01/initiative.md"),
      "plan/a--01/plan/a--01/initiative.md",
    );
  });
});
