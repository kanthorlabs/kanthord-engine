import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMockIdGenerator } from "./ids.ts";

describe("test/helpers/ids.test", () => {
  it('mint("project") with one ulid returns the expected prefixed string', () => {
    const generator = createMockIdGenerator({
      ulids: ["01HZY000000000000000000000"],
    });
    assert.equal(
      generator.mint("project"),
      "project_01HZY000000000000000000000",
    );
  });

  it("two ulids are returned in order across two mint calls with different kinds", () => {
    const generator = createMockIdGenerator({
      ulids: ["01HZY000000000000000000000", "01HZY000000000000000000001"],
    });
    assert.equal(
      generator.mint("project"),
      "project_01HZY000000000000000000000",
    );
    assert.equal(
      generator.mint("repository"),
      "repo_01HZY000000000000000000001",
    );
  });

  it("throws with code ids-exhausted when ulids are exhausted", () => {
    const generator = createMockIdGenerator({
      ulids: ["01HZY000000000000000000000"],
    });
    generator.mint("project");
    assert.throws(() => generator.mint("project"), { code: "ids-exhausted" });
  });
});
