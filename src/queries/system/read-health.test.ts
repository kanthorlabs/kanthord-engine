import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { readHealth } from "./read-health.ts";
import type { DependencyReporter } from "./read-health.ts";
import { systemHealthResponse } from "../../http/contract/system.ts";

type Reporter = DependencyReporter & Readonly<{ calls: () => number }>;

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
    assert.deepEqual(readHealth({ reporters: [] }), {
      status: "ok",
      dependencies: [],
    });
  });

  it("one ok reporter gives ok and one line", () => {
    assert.deepEqual(readHealth({ reporters: [reporter("storage", "ok")] }), {
      status: "ok",
      dependencies: [{ name: "storage", status: "ok" }],
    });
  });

  it("one failed reporter degrades the result", () => {
    assert.deepEqual(
      readHealth({ reporters: [reporter("storage", "failed")] }),
      {
        status: "degraded",
        dependencies: [{ name: "storage", status: "failed" }],
      },
    );
  });

  it("a throwing probe is recorded as failed and never rethrown", () => {
    assert.deepEqual(
      readHealth({ reporters: [reporter("storage", "throw")] }),
      {
        status: "degraded",
        dependencies: [{ name: "storage", status: "failed" }],
      },
    );
  });

  it("a not-implemented reporter alone stays ok", () => {
    assert.deepEqual(
      readHealth({ reporters: [reporter("agent", "not-implemented")] }),
      {
        status: "ok",
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
      }),
      {
        status: "degraded",
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
    });
    assert.deepEqual(
      result.dependencies.map((line) => line.name),
      ["Alpha", "alpha", "zebra"],
    );
  });

  it("calls every probe exactly once, even when an earlier one throws", () => {
    const storage = reporter("storage", "throw");
    const git = reporter("git", "ok");
    readHealth({ reporters: [storage, git] });
    assert.equal(storage.calls(), 1);
    assert.equal(git.calls(), 1);
  });

  it("each result passes systemHealthResponse.parse", () => {
    const result = readHealth({
      reporters: [
        reporter("storage", "ok"),
        reporter("agent", "not-implemented"),
      ],
    });
    assert.equal(systemHealthResponse.safeParse(result).success, true);
  });
});
