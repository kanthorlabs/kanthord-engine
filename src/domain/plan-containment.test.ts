import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { containmentMovable } from "./plan-containment.ts";
import type { ContainmentFacts } from "./plan-graph.ts";
import { nodeKinds } from "./state.ts";

const clear: ContainmentFacts = {
  lease: false,
  workspace: false,
  attemptCommit: false,
  retainedCommit: false,
};

const singleFaultTable: Readonly<
  Array<{ member: keyof ContainmentFacts; facts: ContainmentFacts }>
> = [
  { member: "workspace", facts: { ...clear, workspace: true } },
  { member: "attemptCommit", facts: { ...clear, attemptCommit: true } },
  { member: "retainedCommit", facts: { ...clear, retainedCommit: true } },
];

const allSet: ContainmentFacts = {
  lease: true,
  workspace: true,
  attemptCommit: true,
  retainedCommit: true,
};

function productionTypeScriptFiles(root: string): readonly string[] {
  return (readdirSync(root, { recursive: true }) as string[])
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();
}

function readsContainmentLease(source: string): boolean {
  return (
    source.includes("ContainmentFacts") &&
    /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\.\s*lease\b/.test(source)
  );
}

describe("src/domain/plan-containment.test", () => {
  it("all four members false returns true for each of the three kinds", () => {
    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, clear), true, kind);
    }
  });

  it("each remaining member set alone returns false for each of the three kinds", () => {
    for (const { member, facts } of singleFaultTable) {
      for (const kind of nodeKinds) {
        assert.equal(
          containmentMovable(kind, facts),
          false,
          `${kind} ${member}`,
        );
      }
    }
  });

  it("a live lease no longer blocks a containment move", () => {
    const facts: ContainmentFacts = {
      lease: true,
      workspace: false,
      attemptCommit: false,
      retainedCommit: false,
    };

    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, facts), true, kind);
    }
  });

  it("a workspace still blocks", () => {
    const facts: ContainmentFacts = {
      lease: false,
      workspace: true,
      attemptCommit: false,
      retainedCommit: false,
    };

    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, facts), false, kind);
    }
  });

  it("an attempt commit still blocks", () => {
    const facts: ContainmentFacts = {
      lease: false,
      workspace: false,
      attemptCommit: true,
      retainedCommit: false,
    };

    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, facts), false, kind);
    }
  });

  it("a retained commit still blocks", () => {
    const facts: ContainmentFacts = {
      lease: false,
      workspace: false,
      attemptCommit: false,
      retainedCommit: true,
    };

    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, facts), false, kind);
    }
  });

  it("ContainmentFacts.lease is read by no production file", () => {
    assert.equal(
      readsContainmentLease(
        "const facts: ContainmentFacts = value;\nconst held = facts.lease;",
      ),
      true,
    );

    const srcRoot = resolve(import.meta.dirname, "..");
    const offenders = productionTypeScriptFiles(srcRoot).filter((file) =>
      readsContainmentLease(readFileSync(join(srcRoot, file), "utf8")),
    );
    assert.deepEqual(offenders, []);
  });

  it("all four members set returns false", () => {
    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, allSet), false, kind);
    }
  });

  it("the verdict does not vary with the kind", () => {
    for (const facts of [
      clear,
      allSet,
      ...singleFaultTable.map((row) => row.facts),
    ]) {
      const results = nodeKinds.map((kind) => containmentMovable(kind, facts));
      assert.equal(new Set(results).size, 1, JSON.stringify(facts));
    }
  });
});
