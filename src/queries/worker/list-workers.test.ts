import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workerListResponse } from "../../http/contract/execution.ts";
import { listWorkers } from "./list-workers.ts";

describe("src/queries/worker/list-workers", () => {
  it("returns the registry entries in declaration order", () => {
    assert.deepEqual(listWorkers({}, {}), [
      {
        worker: "claude@1",
        driver: "external",
        agents: [],
        claims: ["objective", "task"],
        deliverables: ["test", "implementation", "review"],
        harness: "claude-code",
        metadata: { composition: "self-managed" },
      },
      {
        worker: "opencode@1",
        driver: "external",
        agents: [],
        claims: ["objective", "task"],
        deliverables: ["test", "implementation", "review"],
        harness: "opencode",
        metadata: { composition: "self-managed" },
      },
    ]);
  });

  it("returns a response that validates against the worker list schema", () => {
    assert.doesNotThrow(() =>
      workerListResponse.parse({ workers: listWorkers({}, {}) }),
    );
  });
});
