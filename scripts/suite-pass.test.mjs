import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildGraph } from "./affected-tests.mjs";
import { keyOf } from "./suite-pass.mjs";
import { stopAfter } from "../src/kernel/stop-test-support.ts";
import { HOST_PATH } from "../src/kernel/pnpm-stub-test-support.ts";

const ENTRY_POINT = fileURLToPath(new URL("./suite-pass.mjs", import.meta.url));
const AFFECTED_REPORTER = fileURLToPath(
  new URL("./affected-reporter.mjs", import.meta.url),
);
const TEST_REPORTER = fileURLToPath(
  new URL("./test-reporter.mjs", import.meta.url),
);
const RUN_TIMEOUT_MS = 120000;
const DROPPED_VARIABLES = ["NODE_TEST_CONTEXT", "GITHUB_STEP_SUMMARY"];
const SUCCESS = 0;
const FAILED = 1;
const RUN_ERROR = 2;
const MAX_RECORDS = 20000;
const TEST_FILES = ["src/a.test.ts", "src/b.test.ts"];
const STORE_PATH = "node_modules/.cache/suite-pass/records.json";
const NODE_TEST_COMMAND =
  "node --test --test-reporter=./scripts/test-reporter.mjs --test-timeout=60000";
const EMPTY_MODULE = "export {};\n";
const SHA256_HEX = /^[0-9a-f]{64}$/;
const OLD_TIME = Date.UTC(2020, 0, 1);

function loggedTest(path, body = "") {
  return `import test from "node:test";
import { appendFileSync } from "node:fs";
test("passes", () => {
  appendFileSync(process.env.RUN_LOG, "${path}\\n");
  ${body}
});
`;
}

function fixturePackage(command = NODE_TEST_COMMAND) {
  return JSON.stringify({ type: "module", scripts: { "test:files": command } });
}

function declaration(timeLimit = 600) {
  return JSON.stringify({
    version: 1,
    command: "true",
    time_limit_s: timeLimit,
    gate_files: ["scripts/gate.mjs"],
  });
}

function configuration(alwaysRun = []) {
  return JSON.stringify({ version: 1, always_run: alwaysRun });
}

async function fixture(t, files = {}) {
  const root = await mkdtemp(join(tmpdir(), "kanthord-suite-pass-"));
  stopAfter(t, () => rm(root, { recursive: true, force: true }));
  const all = {
    "package.json": fixturePackage(),
    ".gitignore": "node_modules/\npnpm-lock.yaml\n",
    ".kanthord/affected-tests.json": declaration(),
    ".kanthord/suite-pass.json": configuration(),
    "scripts/gate.mjs": EMPTY_MODULE,
    "src/a.ts": EMPTY_MODULE,
    "src/a.test.ts": `import "./a.ts";\n${loggedTest("src/a.test.ts")}`,
    "src/b.test.ts": loggedTest("src/b.test.ts"),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await copyFile(TEST_REPORTER, join(root, "scripts/test-reporter.mjs"));
  await copyFile(
    AFFECTED_REPORTER,
    join(root, "scripts/affected-reporter.mjs"),
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  commitAll(root);
  return root;
}

function commitAll(root) {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
}

async function commitFile(root, path, content) {
  await writeFile(join(root, path), content);
  commitAll(root);
}

function runSuitePass(root, flags = [], files = TEST_FILES, extra = {}) {
  const log = `${root}.log`;
  rmSync(log, { force: true });
  const env = { ...process.env, RUN_LOG: log, ...extra };
  for (const name of DROPPED_VARIABLES) delete env[name];
  const result = spawnSync(
    process.execPath,
    [
      ENTRY_POINT,
      "run",
      "--job",
      "test",
      "--concurrency",
      "2",
      ...flags,
      ...files,
    ],
    { cwd: root, env, encoding: "utf8", timeout: RUN_TIMEOUT_MS },
  );
  assert.equal(result.signal, null);
  const ran = existsSync(log)
    ? [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean))].sort()
    : [];
  rmSync(log, { force: true });
  return { ...result, ran };
}

function readStore(root) {
  return JSON.parse(readFileSync(join(root, STORE_PATH), "utf8"));
}

function recordedFiles(root) {
  return Object.values(readStore(root).records)
    .map(({ file }) => file)
    .sort();
}

test("a test file with a matching record is skipped", async (t) => {
  const root = await fixture(t);
  const host = { PATH: HOST_PATH };
  const first = runSuitePass(root, ["--write"], TEST_FILES, host);
  assert.equal(first.status, SUCCESS, first.stderr);
  assert.deepEqual(first.ran, TEST_FILES);
  assert.match(first.stdout, /Skipped: 0 test files/);
  const before = readStore(root).records;
  const second = runSuitePass(root, ["--write"], TEST_FILES, host);
  assert.equal(second.status, SUCCESS, second.stderr);
  assert.deepEqual(second.ran, []);
  assert.match(second.stdout, /Ran: 0 test files/);
  assert.match(second.stdout, /Skipped: 2 test files/);
  assert.match(second.stdout, /Saved share: 100%/);
  assert.deepEqual(readStore(root).records, before);
});

test("a change in the closure of a test file runs it again", async (t) => {
  const root = await fixture(t);
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  await commitFile(root, "src/a.ts", "export const a = 1;\n");
  const second = runSuitePass(root, ["--write"]);
  assert.equal(second.status, SUCCESS, second.stderr);
  assert.deepEqual(second.ran, ["src/a.test.ts"]);
});

test("a change of a global input or a gate file runs every test file", async (t) => {
  const root = await fixture(t);
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  await commitFile(
    root,
    "package.json",
    fixturePackage(`${NODE_TEST_COMMAND} --test-concurrency=2`),
  );
  assert.deepEqual(runSuitePass(root, ["--write"]).ran, TEST_FILES);
  await commitFile(root, ".kanthord/affected-tests.json", declaration(900));
  assert.deepEqual(runSuitePass(root, ["--write"]).ran, TEST_FILES);
  await commitFile(root, "scripts/gate.mjs", "export const gate = 1;\n");
  assert.deepEqual(runSuitePass(root, ["--write"]).ran, TEST_FILES);
  assert.deepEqual(runSuitePass(root, ["--write"]).ran, []);
});

test("a file of always_run runs with a matching record", async (t) => {
  const root = await fixture(t, {
    ".kanthord/suite-pass.json": configuration(["src/b.test.ts"]),
  });
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  const second = runSuitePass(root, ["--write"]);
  assert.equal(second.status, SUCCESS, second.stderr);
  assert.deepEqual(second.ran, ["src/b.test.ts"]);
  assert.match(second.stdout, /Skipped: 1 test files/);
});

test("a dirty or untracked tree writes no record", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "stray.txt"), "");
  const untracked = runSuitePass(root, ["--write"]);
  assert.equal(untracked.status, RUN_ERROR);
  assert.match(untracked.stderr, /clean/);
  assert.deepEqual(untracked.ran, []);
  assert.equal(existsSync(join(root, STORE_PATH)), false);
  await rm(join(root, "stray.txt"));
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  const modified = runSuitePass(root, ["--write"]);
  assert.equal(modified.status, RUN_ERROR);
  assert.equal(existsSync(join(root, STORE_PATH)), false);
});

test("a dirty tree without --write runs every test file", async (t) => {
  const root = await fixture(t);
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  const stored = await readFile(join(root, STORE_PATH), "utf8");
  await writeFile(join(root, "src/a.ts"), "export const a = 1;\n");
  const dirty = runSuitePass(root);
  assert.equal(dirty.status, SUCCESS, dirty.stderr);
  assert.deepEqual(dirty.ran, TEST_FILES);
  assert.equal(await readFile(join(root, STORE_PATH), "utf8"), stored);
});

test("a test run that dirties the tree writes no record", async (t) => {
  const root = await fixture(t, {
    "package.json": fixturePackage(
      `node -e "require('node:fs').writeFileSync('stray.txt', '')" && ${NODE_TEST_COMMAND}`,
    ),
  });
  const result = runSuitePass(root, ["--write"]);
  assert.equal(result.status, RUN_ERROR);
  assert.match(result.stderr, /clean/);
  assert.equal(existsSync(join(root, STORE_PATH)), false);
});

test("an always_run file that dirties the tree writes no record", async (t) => {
  const root = await fixture(t, {
    ".kanthord/suite-pass.json": configuration(["src/b.test.ts"]),
    "src/b.test.ts": loggedTest(
      "src/b.test.ts",
      'if (process.env.WRITE_STRAY) writeFileSync("stray.txt", "");',
    ).replace("{ appendFileSync }", "{ appendFileSync, writeFileSync }"),
  });
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  const stored = await readFile(join(root, STORE_PATH), "utf8");
  const result = runSuitePass(root, ["--write"], TEST_FILES, {
    WRITE_STRAY: "1",
  });
  assert.equal(result.status, RUN_ERROR);
  assert.deepEqual(result.ran, ["src/b.test.ts"]);
  assert.match(result.stderr, /left the work tree/);
  assert.equal(await readFile(join(root, STORE_PATH), "utf8"), stored);
});

test("a file that skips a test writes no record", async (t) => {
  const root = await fixture(t, {
    "src/b.test.ts": `${loggedTest("src/b.test.ts")}test("skipped", { skip: true }, () => {});\n`,
  });
  const first = runSuitePass(root, ["--write"]);
  assert.equal(first.status, SUCCESS, first.stderr);
  assert.deepEqual(recordedFiles(root), ["src/a.test.ts"]);
  const second = runSuitePass(root, ["--write"]);
  assert.equal(second.status, SUCCESS, second.stderr);
  assert.deepEqual(second.ran, ["src/b.test.ts"]);
});

test("a file with a todo test writes no record", async (t) => {
  const root = await fixture(t, {
    "src/b.test.ts": `${loggedTest("src/b.test.ts")}test("later", { todo: true }, () => {});\n`,
  });
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  assert.deepEqual(recordedFiles(root), ["src/a.test.ts"]);
});

test("a failed test file writes no record", async (t) => {
  const root = await fixture(t, {
    "src/b.test.ts": loggedTest("src/b.test.ts", 'throw new Error("boom");'),
  });
  const result = runSuitePass(root, ["--write"]);
  assert.equal(result.status, FAILED);
  assert.deepEqual(result.ran, TEST_FILES);
  assert.deepEqual(recordedFiles(root), ["src/a.test.ts"]);
});

test("the full flag runs every test file and writes records", async (t) => {
  const root = await fixture(t);
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  const before = readStore(root).records;
  const full = runSuitePass(root, ["--write", "--full"]);
  assert.equal(full.status, SUCCESS, full.stderr);
  assert.deepEqual(full.ran, TEST_FILES);
  const after = readStore(root).records;
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const [key, record] of Object.entries(after)) {
    assert.ok(record.written_at > before[key].written_at);
  }
});

test("the key changes with the Node.js version and the pnpm version", async (t) => {
  const root = await fixture(t);
  const graph = buildGraph(root);
  const toolchain = { node: "24.0.0", pnpm: "11.0.0" };
  const key = keyOf(root, graph, "src/a.test.ts", toolchain);
  assert.match(key, SHA256_HEX);
  assert.equal(keyOf(root, graph, "src/a.test.ts", { ...toolchain }), key);
  assert.notEqual(
    keyOf(root, graph, "src/a.test.ts", { ...toolchain, node: "24.1.0" }),
    key,
  );
  assert.notEqual(
    keyOf(root, graph, "src/a.test.ts", { ...toolchain, pnpm: "11.1.0" }),
    key,
  );
});

test("the store keeps the 20000 newest records", async (t) => {
  const root = await fixture(t);
  const records = {};
  for (let index = 0; index < MAX_RECORDS; index += 1) {
    records[`old${index}`] = {
      file: "src/old.test.ts",
      seconds: 1,
      written_at: new Date(OLD_TIME + index).toISOString(),
    };
  }
  await mkdir(dirname(join(root, STORE_PATH)), { recursive: true });
  await writeFile(
    join(root, STORE_PATH),
    JSON.stringify({ version: 1, records }),
  );
  assert.equal(runSuitePass(root, ["--write"]).status, SUCCESS);
  const kept = readStore(root).records;
  assert.equal(Object.keys(kept).length, MAX_RECORDS);
  assert.equal("old0" in kept, false);
  assert.equal("old1" in kept, false);
  assert.equal("old2" in kept, true);
  assert.equal(
    Object.values(kept).filter(({ file }) => TEST_FILES.includes(file)).length,
    TEST_FILES.length,
  );
});
