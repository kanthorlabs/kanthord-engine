import assert from "node:assert/strict";
import { test } from "node:test";
import { toolDeclarations, ToolSource } from "./tool-table.ts";

test("native tool declarations preserve the catalog allowlists", async () => {
  const objectType = "object";
  const swe = await toolDeclarations("swe@1");
  const reviewer = await toolDeclarations("re@1");
  assert.deepEqual(
    swe.map(({ name }) => name),
    ["read", "edit", "write", "grep", "find", "ls", "bash"],
  );
  assert.deepEqual(
    reviewer.map(({ name }) => name),
    ["read", "grep", "find", "ls"],
  );
  for (const declaration of [...swe, ...reviewer]) {
    assert.equal(declaration.source, ToolSource.Builtin);
    assert.equal(declaration.inputSchema.type, objectType);
  }
});
