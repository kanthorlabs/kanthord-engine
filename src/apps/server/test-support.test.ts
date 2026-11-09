import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";

const CHILD_TIMEOUT_MS = 30000;
const TEST_FAILURE = 1;
const DIRECTORY_LINE = /^directory=(.+)$/m;

function failedChildTest(t: TestContext, body: string): string {
  const file = join(temporary(t), "stop.test.mjs");
  const support = (path: string) =>
    JSON.stringify(new URL(path, import.meta.url).href);
  writeFileSync(
    file,
    `import { test } from "node:test";
import { fakeGitHub, fakeS3 } from ${support("./test-support.ts")};
import { stopAfter, temporary } from ${support("../../kernel/test-support.ts")};
test("stops", async (t) => {
${body}
});
`,
  );
  const env = hostEnvironment();
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=spec", file],
    { env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  assert.equal(child.error, undefined, child.stdout);
  assert.equal(child.status, TEST_FAILURE, child.stdout);
  return child.stdout;
}

test("a fixture stop that throws leaves every later stop and directory removal to run", (t) => {
  const output = failedChildTest(
    t,
    `  const github = await fakeGitHub(t);
  await fetch(github.endpoint).catch(() => {});
  await fakeS3(t);
  stopAfter(t, () => {
    throw new Error("Second stop failed.");
  });
  console.log("directory=" + temporary(t));`,
  );
  assert.match(output, /Test stops failed\./);
  assert.match(output, /Fake GitHub failed\./);
  assert.match(output, /Second stop failed\./);
  const directory = DIRECTORY_LINE.exec(output)?.[1];
  assert.ok(directory, output);
  assert.equal(existsSync(directory), false);
});

test("a single stop that throws fails the test with its own error", (t) => {
  const output = failedChildTest(
    t,
    `  stopAfter(t, () => {
    throw new Error("Only stop failed.");
  });`,
  );
  assert.match(output, /Error: Only stop failed\./);
  assert.doesNotMatch(output, /Test stops failed\./);
});
