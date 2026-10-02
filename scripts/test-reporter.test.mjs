import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPORTER = fileURLToPath(new URL("./test-reporter.mjs", import.meta.url));
const TIMEOUT_MS = 10000;
const SUCCESS = 0;
const FAILURE = 1;

async function runFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "kanthord-reporter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.test.mjs");
  await writeFile(file, source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-reporter=${REPORTER}`, file],
    { encoding: "utf8", timeout: TIMEOUT_MS, env },
  );
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { ...result, output: result.stdout + result.stderr };
}

test("reporter prints totals without passing names or successful stdout", async (t) => {
  const result = await runFixture(
    t,
    `import test from 'node:test';
test('successful fixture', () => console.log('successful noise'));
`,
  );
  assert.equal(result.status, SUCCESS);
  assert.match(result.output, /tests 1/);
  assert.match(result.output, /pass 1/);
  assert.match(result.output, /fail 0/);
  assert.doesNotMatch(result.output, /successful fixture|successful noise/);
});

test("reporter retains nested assertion details, source stack and failure status", async (t) => {
  const result = await runFixture(
    t,
    `import test from 'node:test';
import assert from 'node:assert/strict';
test('parent', async t => {
  await t.test('failing child', () => assert.equal('actual-value', 'expected-value'));
});
`,
  );
  assert.equal(result.status, FAILURE);
  assert.match(result.output, /failing child/);
  assert.match(result.output, /actual-value/);
  assert.match(result.output, /expected-value/);
  assert.match(result.output, /fixture\.test\.mjs:\d+:\d+/);
  assert.match(result.output, /fail 2/);
});

test("reporter retains hook errors and stderr diagnostics", async (t) => {
  const result = await runFixture(
    t,
    `import test, { before } from 'node:test';
before(() => { throw new Error('hook failure detail'); });
console.error('stderr diagnostic');
test('hook fixture', () => {});
`,
  );
  assert.equal(result.status, FAILURE);
  assert.match(result.output, /hook failure detail/);
  assert.match(result.output, /fixture\.test\.mjs:\d+:\d+/);
  assert.match(result.output, /stderr diagnostic/);
});
