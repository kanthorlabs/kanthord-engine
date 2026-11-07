import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolSource } from "../agent/contract.ts";
import { toolDeclarations } from "./tool-declarations.ts";

const HOST_TOOL_COUNT = 2;

test("native tool declarations preserve the catalog allowlists", async () => {
  const objectType = "object";
  const swe = await toolDeclarations("swe@1");
  const reviewer = await toolDeclarations("re@1");
  assert.deepEqual(
    swe.map(({ name }) => name),
    [
      "read",
      "edit",
      "write",
      "grep",
      "find",
      "ls",
      "bash",
      "evidence-upload",
      "link_update_list",
    ],
  );
  assert.deepEqual(
    reviewer.map(({ name }) => name),
    ["read", "grep", "find", "ls"],
  );
  for (const declaration of swe.slice(-HOST_TOOL_COUNT))
    assert.equal(declaration.source, ToolSource.Host);
  for (const declaration of [...swe.slice(0, -HOST_TOOL_COUNT), ...reviewer]) {
    assert.equal(declaration.source, ToolSource.Builtin);
    assert.equal(declaration.input_schema.type, objectType);
  }
});
