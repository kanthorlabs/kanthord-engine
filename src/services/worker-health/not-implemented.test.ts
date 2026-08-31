import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkerHealthError } from "./index.ts";
import { NotImplementedWorkerHealth } from "./not-implemented.ts";

describe("src/services/worker-health/not-implemented", () => {
  it("throws the not-implemented worker health error synchronously", () => {
    const health = new NotImplementedWorkerHealth();

    assert.throws(
      () => {
        health.check({ worker: "claude@1", instanceId: "i1" });
      },
      (error: unknown) =>
        error instanceof WorkerHealthError && error.code === "not-implemented",
    );
  });
});
