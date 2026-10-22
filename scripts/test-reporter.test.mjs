import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const REPORTER = fileURLToPath(new URL("./test-reporter.mjs", import.meta.url));
const SUCCESS = 0;
const FAILURE = 1;

async function runFixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "kanthord-reporter-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture.test.mjs");
  await writeFile(file, source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ["--test", `--test-reporter=${REPORTER}`, file],
    { env, signal: t.signal },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const [status, signal] = await once(child, "close");
  assert.equal(signal, null);
  return { status, stdout, stderr, output: stdout + stderr };
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
