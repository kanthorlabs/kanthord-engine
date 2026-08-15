import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildErrorEnvelope } from "./errors.ts";
import { findOperation } from "./registry.ts";

describe("src/http/contract/project.test", () => {
  it("project.repositories declares binding-in-use in its errors map", () => {
    const entry = findOperation("project.repositories");
    assert.ok(entry !== undefined);
    const details = entry.errors?.["binding-in-use"] ?? null;
    if (details === null) {
      assert.fail("binding-in-use is not declared on project.repositories");
    }
    assert.equal(typeof details.parse, "function");
  });

  it("the binding-in-use envelope carries a blockers details list", () => {
    const entry = findOperation("project.repositories");
    const envelope = buildErrorEnvelope(entry!.errors!);
    const parsed = envelope.safeParse({
      error: {
        code: "binding-in-use",
        message: "a stored objective names a repository the new set drops",
        details: {
          blockers: [{ nodeId: "objective_a", blocker: "repository-bound" }],
        },
      },
    });
    assert.equal(parsed.success, true);
  });
});
