import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportEntry } from "./contract.ts";
import { serializePlanFile } from "./export.ts";
import { parsePlanFile } from "./parser.ts";

test("serializePlanFile writes no id for an entry without an id and parses back", () => {
  const entry: ImportEntry = {
    filename: "add-login.md",
    kind: "objective",
    parent: "authentication.md",
    depends_on: [],
    bindings: [],
    verifications: ["pnpm test"],
    name: "Add login",
    requirement: "A user signs in with an email and a password.",
    criterion: "A signed-in user sees the home page.",
  };
  const content = serializePlanFile(entry);
  assert.ok(!/^id:/m.test(content));
  assert.deepEqual(parsePlanFile(entry.filename, content), entry);
});
