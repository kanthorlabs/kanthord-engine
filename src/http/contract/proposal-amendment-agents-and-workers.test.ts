import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const document = readFileSync(
  resolve(
    import.meta.dirname,
    "../../../docs/proposal/phase-2/agents-and-workers.md",
  ),
  "utf8",
);

describe("src/http/contract/proposal-amendment-agents-and-workers.test", () => {
  it("records the internal-worker deferral in one location", () => {
    const internalWorkerLists =
      document.match(
        /`general@1`,\s*`tdd@1`,\s*`poc@1`,\s*`research@1`\s+and\s+`git@1`/g,
      ) ?? [];

    assert.equal(
      internalWorkerLists.length,
      1,
      "the internal-worker deferral is duplicated",
    );
  });
});
