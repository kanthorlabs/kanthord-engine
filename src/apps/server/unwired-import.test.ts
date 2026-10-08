import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");
const SERVER_ROOT = import.meta.dirname;
const UNWIRED_MODULE = "unwired.ts";
const UNWIRED_TEST_MODULE = "unwired.test.ts";
const COMPOSITION_MODULE = "index.ts";
const UNWIRED_SEAMS: string[] = [];
const TYPESCRIPT_EXTENSION = ".ts";
const IMPORT_SPECIFIER = new RegExp(
  "(?:from|import\\s*\\(?)\\s*[\"'][^\"']*" + "unwired",
);
const UNWIRED_CALL = new RegExp("unwired" + "\\(");

test("only the helper test imports the unwired module", () => {
  assert.equal(existsSync(join(SERVER_ROOT, UNWIRED_MODULE)), true);
  assert.equal(existsSync(join(SERVER_ROOT, UNWIRED_TEST_MODULE)), true);
  const imports: string[] = [];

  for (const entry of readdirSync(SOURCE_ROOT, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(TYPESCRIPT_EXTENSION)) continue;
    const file = join(entry.parentPath, entry.name);
    if (IMPORT_SPECIFIER.test(readFileSync(file, "utf8"))) imports.push(file);
  }
  assert.deepEqual(imports, [join(SERVER_ROOT, UNWIRED_TEST_MODULE)]);
});

test("the composition root wires every seam", () => {
  assert.deepEqual(UNWIRED_SEAMS, []);
  const source = readFileSync(join(SERVER_ROOT, COMPOSITION_MODULE), "utf8");
  assert.equal(UNWIRED_CALL.test(source), false);
  assert.equal(IMPORT_SPECIFIER.test(source), false);
});
