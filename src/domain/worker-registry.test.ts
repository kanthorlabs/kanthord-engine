import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkerId } from "./worker-id.ts";
import { compositions, workerRegistry } from "./worker-registry.ts";
import { workerKinds } from "./worker.ts";

describe("src/domain/worker-registry", () => {
  it("holds every worker field in routing order", () => {
    assert.deepEqual(workerRegistry, [
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

  it("describes both workers as self-managed external harnesses with no agents", () => {
    for (const entry of workerRegistry) {
      assert.equal(entry.driver, "external");
      assert.deepEqual(entry.agents, []);
      assert.notEqual(entry.harness, null);
      assert.equal(entry.metadata.composition, "self-managed");
    }
    assert.equal(
      workerRegistry.every((entry) => entry.agents.length === 0),
      true,
    );
  });

  it("declares neither expansion deliverables nor initiative claims", () => {
    assert.equal(
      workerRegistry.every(
        (entry) => !entry.deliverables.includes("expansion"),
      ),
      true,
    );
    assert.equal(
      workerRegistry.every((entry) => !entry.claims.includes("initiative")),
      true,
    );
  });

  it("keeps the closed composition set", () => {
    assert.deepEqual(compositions, ["single", "composed", "self-managed"]);
  });

  it("uses valid worker ids outside the legacy worker kinds", () => {
    assert.equal(parseWorkerId(workerRegistry[0].worker).id, "claude@1");
    assert.equal(parseWorkerId(workerRegistry[1].worker).id, "opencode@1");
    assert.equal(
      workerRegistry.every(
        (entry) => !workerKinds.includes(entry.worker as never),
      ),
      true,
    );
  });
});
