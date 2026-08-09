import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const runnerEntry = fileURLToPath(new URL("../run.mjs", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("scripts/e2e/run.mjs refuses an unknown scenario id, exits 2, and writes the refusal to stderr", () => {
  const result = spawnSync(process.execPath, [runnerEntry, "P1-E9"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.equal(
    result.stderr,
    "e2e: invalid-argument: unknown scenario P1-E9; known ids are P1-E1, P1-E2, P1-E4, P1-E5\n",
  );
});

test("scripts/e2e/run.mjs refuses with no scenario id and exits 2", () => {
  const result = spawnSync(process.execPath, [runnerEntry], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
});

test("scripts/e2e/run.mjs holds no logic beyond importing and invoking main", () => {
  const text = readFileSync(runnerEntry, "utf8");

  assert.match(
    text,
    /^#!\/usr\/bin\/env node\nimport \{ main \} from "\.\/lib\/main\.ts";\n\nprocess\.exitCode = await main\(process\.argv\.slice\(2\)\);\n$/,
  );
});
