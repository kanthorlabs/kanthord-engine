import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readHealth } from "./read-health.ts";
import type { DependencyReporter } from "./read-health.ts";
import { systemHealthResponse } from "../../http/contract/system.ts";

type Reporter = DependencyReporter & Readonly<{ calls: () => number }>;

const VERSION = "27.8.1";
const CAPABILITIES = [
  "per-node-write",
  "project-graph",
  "worker-model",
] as const;

const reporter = (
  name: string,
  result: "ok" | "failed" | "not-implemented" | "throw",
): Reporter => {
  let calls = 0;
  return {
    name,
    probe: () => {
      calls += 1;
      if (result === "throw") {
        throw new Error(`${name} probe failed`);
      }
      return result;
    },
    calls: () => calls,
  };
};

describe("src/queries/system/read-health.test", () => {
  it("no reporters gives ok with an empty dependency list", () => {
    assert.deepEqual(
      readHealth({
        reporters: [],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "ok",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [],
      },
    );
  });

  it("one ok reporter gives ok and one line", () => {
    assert.deepEqual(
      readHealth({
        reporters: [reporter("storage", "ok")],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "ok",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [{ name: "storage", status: "ok" }],
      },
    );
  });

  it("one failed reporter degrades the result", () => {
    assert.deepEqual(
      readHealth({
        reporters: [reporter("storage", "failed")],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "degraded",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [{ name: "storage", status: "failed" }],
      },
    );
  });

  it("a throwing probe is recorded as failed and never rethrown", () => {
    assert.deepEqual(
      readHealth({
        reporters: [reporter("storage", "throw")],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "degraded",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [{ name: "storage", status: "failed" }],
      },
    );
  });

  it("a not-implemented reporter alone stays ok", () => {
    assert.deepEqual(
      readHealth({
        reporters: [reporter("agent", "not-implemented")],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "ok",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [{ name: "agent", status: "not-implemented" }],
      },
    );
  });

  it("a not-implemented reporter beside a failed one degrades", () => {
    assert.deepEqual(
      readHealth({
        reporters: [
          reporter("agent", "not-implemented"),
          reporter("storage", "failed"),
        ],
        version: VERSION,
        capabilities: CAPABILITIES,
      }),
      {
        status: "degraded",
        version: VERSION,
        capabilities: CAPABILITIES,
        dependencies: [
          { name: "agent", status: "not-implemented" },
          { name: "storage", status: "failed" },
        ],
      },
    );
  });

  it("orders lines bytewise by name, not input order", () => {
    const result = readHealth({
      reporters: [
        reporter("zebra", "ok"),
        reporter("Alpha", "ok"),
        reporter("alpha", "ok"),
      ],
      version: VERSION,
      capabilities: CAPABILITIES,
    });
    assert.deepEqual(
      result.dependencies.map((line) => line.name),
      ["Alpha", "alpha", "zebra"],
    );
  });

  it("calls every probe exactly once, even when an earlier one throws", () => {
    const storage = reporter("storage", "throw");
    const git = reporter("git", "ok");
    readHealth({
      reporters: [storage, git],
      version: VERSION,
      capabilities: CAPABILITIES,
    });
    assert.equal(storage.calls(), 1);
    assert.equal(git.calls(), 1);
  });

  it("returns the injected version and capability list", () => {
    const result = readHealth({
      reporters: [reporter("storage", "ok")],
      version: VERSION,
      capabilities: CAPABILITIES,
    });
    assert.equal(result.version, VERSION);
    assert.deepEqual(result.capabilities, [
      "per-node-write",
      "project-graph",
      "worker-model",
    ]);
  });

  it("an empty capability list stays empty and stays ok", () => {
    const result = readHealth({
      reporters: [reporter("storage", "ok")],
      version: VERSION,
      capabilities: [],
    });
    assert.deepEqual(result.capabilities, []);
    assert.equal(result.status, "ok");
  });

  it("a throwing probe leaves the version and capabilities unchanged", () => {
    const result = readHealth({
      reporters: [reporter("storage", "throw")],
      version: VERSION,
      capabilities: CAPABILITIES,
    });
    assert.equal(result.status, "degraded");
    assert.equal(result.version, VERSION);
    assert.deepEqual(result.capabilities, [
      "per-node-write",
      "project-graph",
      "worker-model",
    ]);
  });

  it("returns capabilities in injected order, not re-sorted", () => {
    const result = readHealth({
      reporters: [],
      version: VERSION,
      capabilities: ["project-graph", "worker-model"],
    });
    assert.deepEqual(result.capabilities, ["project-graph", "worker-model"]);
  });

  it("each result passes systemHealthResponse.parse", () => {
    const result = readHealth({
      reporters: [
        reporter("storage", "ok"),
        reporter("agent", "not-implemented"),
      ],
      version: VERSION,
      capabilities: CAPABILITIES,
    });
    assert.equal(systemHealthResponse.safeParse(result).success, true);
  });
});
