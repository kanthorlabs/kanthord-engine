import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { workerRegistry } from "./worker-registry.ts";
import {
  capableWorkers,
  routeWorker,
  WorkerRoutingError,
} from "./worker-routing.ts";

type RoutingErrorCode = WorkerRoutingError["code"];

function assertRoutingError(
  code: RoutingErrorCode,
  input: Parameters<typeof routeWorker>[0],
): void {
  assert.throws(
    () => routeWorker(input),
    (error) => {
      assert.ok(error instanceof WorkerRoutingError);
      assert.equal(error.code, code);
      return true;
    },
  );
}

describe("src/domain/worker-routing", () => {
  it("finds capable workers in registry order", () => {
    assert.deepEqual(
      capableWorkers(workerRegistry, {
        kind: "task",
        deliverable: "implementation",
      }),
      ["claude@1", "opencode@1"],
    );
  });

  it("finds no capable worker for deferred expansion work", () => {
    assert.deepEqual(
      capableWorkers(workerRegistry, {
        kind: "initiative",
        deliverable: "expansion",
      }),
      [],
    );
    assert.deepEqual(
      capableWorkers(workerRegistry, {
        kind: "objective",
        deliverable: "expansion",
      }),
      [],
    );
  });

  it("names capable when no worker supports the work", () => {
    assert.deepEqual(
      routeWorker({
        registry: workerRegistry,
        kind: "initiative",
        deliverable: "expansion",
        authorized: [],
        available: [],
      }),
      { routed: false, refusal: "unroutable", failedSet: "capable" },
    );
    assert.deepEqual(
      routeWorker({
        registry: workerRegistry,
        kind: "task",
        deliverable: "research",
        authorized: [],
        available: [],
      }),
      { routed: false, refusal: "unroutable", failedSet: "capable" },
    );
  });

  it("names authorized when no capable worker is authorized", () => {
    assert.deepEqual(
      routeWorker({
        registry: workerRegistry,
        kind: "task",
        deliverable: "implementation",
        authorized: [],
        available: [],
      }),
      { routed: false, refusal: "unroutable", failedSet: "authorized" },
    );
  });

  it("names available when no authorized worker is available", () => {
    assert.deepEqual(
      routeWorker({
        registry: workerRegistry,
        kind: "task",
        deliverable: "implementation",
        authorized: ["claude@1"],
        available: [],
      }),
      { routed: false, refusal: "unroutable", failedSet: "available" },
    );
  });

  it("routes to the earliest eligible worker by registry order", () => {
    const result = routeWorker({
      registry: workerRegistry,
      kind: "task",
      deliverable: "implementation",
      authorized: ["claude@1", "opencode@1"],
      available: ["claude@1", "opencode@1"],
    });

    assert.equal(result.routed, true);
    assert.equal(result.routed && result.worker.worker, "claude@1");
  });

  it("routes to a later worker when the earlier worker is not authorized", () => {
    const result = routeWorker({
      registry: workerRegistry,
      kind: "task",
      deliverable: "implementation",
      authorized: ["opencode@1"],
      available: ["opencode@1"],
    });

    assert.equal(result.routed, true);
    assert.equal(result.routed && result.worker.worker, "opencode@1");
  });

  it("routes supported objective work", () => {
    assert.deepEqual(
      routeWorker({
        registry: workerRegistry,
        kind: "objective",
        deliverable: "implementation",
        authorized: ["claude@1"],
        available: ["claude@1"],
      }),
      { routed: true, worker: workerRegistry[0] },
    );
  });

  it("refuses an unknown worker id before capability validation", () => {
    assertRoutingError("worker-unknown-id", {
      registry: workerRegistry,
      kind: "objective",
      deliverable: "expansion",
      authorized: ["unknown@1"],
      available: [],
    });
  });

  it("refuses a duplicate worker id", () => {
    assertRoutingError("worker-duplicate-id", {
      registry: workerRegistry,
      kind: "task",
      deliverable: "implementation",
      authorized: ["claude@1", "claude@1"],
      available: [],
    });
  });

  it("refuses an authorized worker outside the capable set", () => {
    assertRoutingError("authorized-not-capable", {
      registry: workerRegistry,
      kind: "objective",
      deliverable: "expansion",
      authorized: ["claude@1"],
      available: [],
    });
  });

  it("refuses an available worker outside the authorized set", () => {
    assertRoutingError("available-not-authorized", {
      registry: workerRegistry,
      kind: "task",
      deliverable: "implementation",
      authorized: ["claude@1"],
      available: ["opencode@1"],
    });
  });
});
