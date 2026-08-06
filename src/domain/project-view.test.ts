import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { ProjectView } from "./project-view.ts";

function bytewiseSorted(keys: readonly string[]): readonly string[] {
  return [...keys].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
}

describe("src/domain/project-view.test", () => {
  it("carries exactly the four members in bytewise order", () => {
    const view: ProjectView = {
      id: "project_a",
      name: "kanthord-verify",
      repositories: ["repo_a"],
      updatedAt: 1700000000000,
    };
    assert.deepEqual(bytewiseSorted(Object.keys(view)), [
      "id",
      "name",
      "repositories",
      "updatedAt",
    ]);
  });
});
