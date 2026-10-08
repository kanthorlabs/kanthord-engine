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
const NO_SEAMS = 0;
const TYPESCRIPT_EXTENSION = ".ts";
const IMPORT_SPECIFIER = new RegExp(
  "(?:from|import\\s*\\(?)\\s*[\"'][^\"']*" + "unwired",
);

test("only the composition root and helper test import the exact unwired seams", () => {
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
  assert.deepEqual(
    imports.sort(),
    [
      UNWIRED_TEST_MODULE,
      ...(UNWIRED_SEAMS.length > NO_SEAMS ? [COMPOSITION_MODULE] : []),
    ]
      .map((name) => join(SERVER_ROOT, name))
      .sort(),
  );
  const source = readFileSync(join(SERVER_ROOT, COMPOSITION_MODULE), "utf8");
  const seams = [...source.matchAll(/unwired\(\s*"([^"]+)"\s*,?\s*\)/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(seams.sort(), [...UNWIRED_SEAMS].sort());
});
