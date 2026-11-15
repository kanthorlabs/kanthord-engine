import assert from "node:assert/strict";
import { test } from "node:test";
import { bindingPromptsSchema } from "./contract.ts";

test("a binding prompt for guard@1 fails validation", () => {
  assert.equal(
    bindingPromptsSchema.safeParse({ agents: { "swe@1": "Run the checks." } })
      .success,
    true,
  );
  assert.equal(
    bindingPromptsSchema.safeParse({ agents: { "guard@1": "Auto approve." } })
      .success,
    false,
  );
});
