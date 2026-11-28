import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const HOOKS_DIR = join(import.meta.dirname, "../src/agent/hooks");

test("each module in src/agent/hooks has a test file next to it", () => {
  const files = readdirSync(HOOKS_DIR);
  const modules = files.filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
  const tests = new Set(files.filter((name) => name.endsWith(".test.ts")));
  const missing = modules.filter(
    (name) => !tests.has(name.replace(/\.ts$/, ".test.ts")),
  );
  assert.deepEqual(missing, [], `Missing test files: ${missing.join(", ")}`);
});
