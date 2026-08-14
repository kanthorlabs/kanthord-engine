import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  nodeWriteKinds,
  revisionGuardClasses,
  revisionGuardFor,
} from "./revision-guard.ts";

describe("src/domain/revision-guard.test", () => {
  it("nodeWriteKinds pins the four write kinds in order", () => {
    assert.equal(nodeWriteKinds.length, 4);
    assert.deepEqual(
      [...nodeWriteKinds],
      ["create", "update-fields", "update-topology", "delete"],
    );
  });

  it("revisionGuardClasses pins the two classes in order", () => {
    assert.equal(revisionGuardClasses.length, 2);
    assert.deepEqual([...revisionGuardClasses], ["node", "project"]);
  });

  it("revisionGuardFor maps update-fields to node and every other kind to project", () => {
    assert.equal(revisionGuardFor("create"), "project");
    assert.equal(revisionGuardFor("update-fields"), "node");
    assert.equal(revisionGuardFor("update-topology"), "project");
    assert.equal(revisionGuardFor("delete"), "project");
  });

  it("the revision guard result set is exactly node and project", () => {
    const result = new Set(nodeWriteKinds.map(revisionGuardFor));
    assert.equal(result.size, 2);
    assert.deepEqual([...result].sort(), ["node", "project"]);
  });
});
