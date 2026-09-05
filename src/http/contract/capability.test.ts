import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  capabilityName,
  capabilityOperations,
  declaredCapabilities,
} from "./capability.ts";
import { findOperation, registry } from "./registry.ts";

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
const capabilityNames = Object.keys(capabilityOperations) as Array<
  keyof typeof capabilityOperations
>;

describe("src/http/contract/capability.test", () => {
  it("every capability operation id resolves in the real registry", () => {
    for (const name of capabilityNames) {
      for (const operationId of capabilityOperations[name]!) {
        assert.ok(findOperation(operationId), operationId);
      }
    }
  });

  it("every capability operation id is routed in the real registry", () => {
    for (const name of capabilityNames) {
      for (const operationId of capabilityOperations[name]!) {
        assert.equal(findOperation(operationId)!.status, "routed", operationId);
      }
    }
  });

  it("the map keys and the zod enum agree", () => {
    assert.deepEqual(capabilityName.options, Object.keys(capabilityOperations));
    assert.deepEqual(
      [...capabilityName.options].sort(bytewise),
      capabilityName.options,
    );
  });

  it("worker-model is the last key", () => {
    assert.equal(Object.keys(capabilityOperations).at(-1), "worker-model");
  });

  it("declaredCapabilities omits external-drive and includes worker-model", () => {
    assert.deepEqual(declaredCapabilities(registry), [
      "event-wait",
      "per-node-write",
      "project-graph",
      "worker-model",
    ]);
  });

  it("external-drive is not a capability name", () => {
    assert.equal(Object.hasOwn(capabilityOperations, "external-drive"), false);
    assert.equal(capabilityName.safeParse("external-drive").success, false);
  });

  it("worker-model names the four worker operations", () => {
    assert.deepEqual(capabilityOperations["worker-model"], [
      "node.claim",
      "node.renew",
      "node.release",
      "node.report",
    ]);
  });

  it("event-wait maps to exactly one operation", () => {
    assert.deepEqual(capabilityOperations["event-wait"], ["event.list"]);
  });

  it("event-wait is the first key of the capability map", () => {
    assert.equal(Object.keys(capabilityOperations)[0], "event-wait");
  });

  it("stubbing node.report removes worker-model", () => {
    const fixture = registry.map((entry) =>
      entry.operationId === "node.report"
        ? { ...entry, status: "stubbed" as const }
        : entry,
    );
    assert.deepEqual(declaredCapabilities(fixture), [
      "event-wait",
      "per-node-write",
      "project-graph",
    ]);
  });

  it("a stubbed event.list suppresses the event-wait name", () => {
    const fixture = registry.map((entry) =>
      entry.operationId === "event.list"
        ? { ...entry, status: "stubbed" as const }
        : entry,
    );
    assert.deepEqual(declaredCapabilities(fixture), [
      "per-node-write",
      "project-graph",
      "worker-model",
    ]);
  });

  it("an absent operation suppresses its name", () => {
    const fixture = registry.filter(
      (entry) => entry.operationId !== "project.graph",
    );
    assert.deepEqual(declaredCapabilities(fixture), [
      "event-wait",
      "per-node-write",
      "worker-model",
    ]);
  });

  it("an absent event.list suppresses the event-wait name", () => {
    const fixture = registry.filter(
      (entry) => entry.operationId !== "event.list",
    );
    assert.deepEqual(declaredCapabilities(fixture), [
      "per-node-write",
      "project-graph",
      "worker-model",
    ]);
  });

  it("the result is bytewise sorted, not insertion ordered", () => {
    const first = declaredCapabilities(registry);
    assert.deepEqual(first, [...first].sort(bytewise));
    assert.deepEqual(declaredCapabilities(registry), first);
  });

  it("an empty registry declares nothing", () => {
    assert.deepEqual(declaredCapabilities([]), []);
  });
});
