import { describe, it } from "node:test";
import assert from "node:assert/strict";

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
  { member: "lease", facts: { ...clear, lease: true } },
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

describe("src/domain/plan-containment.test", () => {
  it("all four members false returns true for each of the three kinds", () => {
    for (const kind of nodeKinds) {
      assert.equal(containmentMovable(kind, clear), true, kind);
    }
  });

  it("each of the four members set alone returns false for each of the three kinds", () => {
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
