import assert from "node:assert/strict";
import { test } from "node:test";
import { getAgentDeclaration } from "./catalog.ts";

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});
