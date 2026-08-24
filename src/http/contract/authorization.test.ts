import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registry, findOperation } from "./registry.ts";
import type { Operation } from "./operation.ts";

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));

describe("src/http/contract/authorization.test", () => {
  it("the registry-wide harness set equals the named list by bytewise order", () => {
    const actual = registry
      .filter((entry) => entry.allowedActors.includes("harness"))
      .map((entry) => entry.operationId)
      .sort(bytewise);

    const expected = [
      "blob.show",
      "edge.list",
      "node.claim",
      "node.create",
      "node.delete",
      "node.heartbeat",
      "node.list",
      "node.release",
      "node.report",
      "node.show",
      "node.update",
      "plan.export",
      "plan.revisions",
      "project.list",
      "project.nodes",
      "project.show",
      "project.status",
      "system.health",
    ];

    assert.deepEqual(actual, expected);
  });

  it("project.nodes is in the registry-wide harness set", () => {
    const entry = findOperation("project.nodes");
    assert.ok(entry, "project.nodes operation not found");
    assert.ok(
      entry.allowedActors.includes("harness"),
      "project.nodes missing harness actor",
    );
  });

  it("project.graph is not in the registry-wide harness set", () => {
    const entry = findOperation("project.graph");
    assert.ok(entry, "project.graph operation not found");
    assert.ok(
      !entry.allowedActors.includes("harness"),
      "project.graph unexpectedly admits harness actor",
    );
    assert.deepEqual(entry.allowedActors, ["human"]);
  });

  it("the registry-wide harness set totals eighteen operations", () => {
    const harnessCount = registry.filter((entry) =>
      entry.allowedActors.includes("harness"),
    ).length;
    assert.equal(harnessCount, 18);
  });

  it("plan.revisions is in the registry-wide harness set", () => {
    const entry = findOperation("plan.revisions");
    assert.ok(entry, "plan.revisions operation not found");
    assert.deepEqual(entry.allowedActors, ["human", "harness"]);
  });
});
