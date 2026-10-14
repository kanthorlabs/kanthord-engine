import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolSource } from "../agent/contract.ts";
import { toolDeclarations } from "./tool-declarations.ts";

test("native tool declarations preserve the catalog allowlists", async () => {
  const objectType = "object";
  const swe = await toolDeclarations("swe@1");
  const reviewer = await toolDeclarations("re@1");
  assert.deepEqual(
    swe.map(({ name }) => name),
    ["read", "edit", "write", "grep", "find", "ls", "bash", "evidence-upload"],
  );
  assert.deepEqual(
    reviewer.map(({ name }) => name),
    ["read", "grep", "find", "ls"],
  );
  assert.equal(swe.at(-1)!.source, ToolSource.Host);
  for (const declaration of [...swe.slice(0, -1), ...reviewer]) {
    assert.equal(declaration.source, ToolSource.Builtin);
    assert.equal(declaration.input_schema.type, objectType);
  }
});
