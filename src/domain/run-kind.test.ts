import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { deliverables } from "./deliverable.ts";
import { runKindFor, runKinds } from "./run-kind.ts";

describe("src/domain/run-kind.test", () => {
  it("runKinds equals the pinned tuple in its declared order", () => {
    assert.deepEqual([...runKinds], ["structural", "execution", "review"]);
    assert.equal(runKinds.length, 3);
  });

  it("runKindFor maps expansion to structural", () => {
    assert.equal(runKindFor("expansion"), "structural");
  });

  it("runKindFor maps test to execution", () => {
    assert.equal(runKindFor("test"), "execution");
  });

  it("runKindFor maps implementation to execution", () => {
    assert.equal(runKindFor("implementation"), "execution");
  });

  it("runKindFor maps review to review", () => {
    assert.equal(runKindFor("review"), "review");
  });

  it("runKindFor is total over the deliverables tuple", () => {
    for (const value of deliverables) {
      const result = runKindFor(value);
      assert.ok(runKinds.includes(result), `${value} produced ${result}`);
    }

    assert.equal(deliverables.length, 4);
  });

  it("every run kind is produced by at least one deliverable", () => {
    const produced = new Set(deliverables.map(runKindFor));
    assert.deepEqual([...produced].sort(), [
      "execution",
      "review",
      "structural",
    ]);
  });
});
