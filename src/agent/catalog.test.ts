import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_DECLARATIONS, getAgentDeclaration } from "./catalog.ts";

test("unknown and inherited names are not agent declarations", () => {
  assert.equal(getAgentDeclaration("unknown"), undefined);
  assert.equal(getAgentDeclaration("constructor"), undefined);
  assert.equal(getAgentDeclaration("__proto__"), undefined);
});

test("(invariant guard) the lowercased display_name values of AGENT_DECLARATIONS are unique", () => {
  const names = Object.values(AGENT_DECLARATIONS).map(({ display_name }) =>
    display_name.toLowerCase(),
  );
  assert.equal(new Set(names).size, names.length);
});
