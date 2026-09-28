import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const SOURCE_ROOT = resolve(import.meta.dirname, "../..");
const SERVER_ROOT = import.meta.dirname;
const UNWIRED_MODULE = "unwired.ts";
const UNWIRED_TEST_MODULE = "unwired.test.ts";
const TYPESCRIPT_EXTENSION = ".ts";
const IMPORT_SPECIFIER = new RegExp(
  "(?:from|import\\s*\\(?)\\s*[\"'][^\"']*" + "unwired",
);

test("unwired module is absent and no source imports or re-exports it", () => {
  assert.equal(existsSync(join(SERVER_ROOT, UNWIRED_MODULE)), false);
  assert.equal(existsSync(join(SERVER_ROOT, UNWIRED_TEST_MODULE)), false);

  for (const entry of readdirSync(SOURCE_ROOT, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith(TYPESCRIPT_EXTENSION)) continue;
    const file = join(entry.parentPath, entry.name);
    assert.doesNotMatch(readFileSync(file, "utf8"), IMPORT_SPECIFIER, file);
  }
});
