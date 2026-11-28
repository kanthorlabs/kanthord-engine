import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const OUTER_TIMEOUT_MS = 10000;
const FIXTURE_TIMEOUT_MS = 5000;
const FORCE_EXIT = "--test-force-exit";
const SUCCESS = 0;
const NODE_COMMAND = "node --test";
const FIXTURE_A = `import test from "node:test";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
test("leaves a live child", () => {
  const child = spawn("sleep", ["600"], { stdio: "ignore" });
  writeFileSync(process.env.SLEEP_PID_FILE, String(child.pid));
});
`;
const FIXTURE_B = `import test from "node:test";
test("never settling stop", (t) => {
  t.after(() => new Promise(() => {}));
});
`;

const directories = [];
const groups = [];
const sleepPidFiles = [];

function nodeTestArguments() {
  const script = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).scripts[
    "test:files"
  ];
  const command = script.slice(script.indexOf(NODE_COMMAND));
  return command
    .split(" ")
    .slice(1)
    .filter((argument) => !argument.startsWith("--test-reporter="))
    .map((argument) =>
      argument.startsWith("--test-timeout=")
        ? `--test-timeout=${FIXTURE_TIMEOUT_MS}`
        : argument,
    );
}

function killGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function killSleep(pidFile) {
  let pid;
  try {
    pid = Number(readFileSync(pidFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function runFixture(source, argumentsList) {
  const directory = await mkdtemp(join(tmpdir(), "kanthord-force-exit-"));
  directories.push(directory);
  const file = join(directory, "fixture.test.mjs");
  const sleepPidFile = join(directory, "sleep.pid");
  sleepPidFiles.push(sleepPidFile);
  await writeFile(file, source);
  const env = { ...process.env, SLEEP_PID_FILE: sleepPidFile };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [...argumentsList, file], {
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  groups.push(child.pid);
  let output = "";
  const collect = (chunk) => {
    output += chunk;
  };
  child.stdout.setEncoding("utf8").on("data", collect);
  child.stderr.setEncoding("utf8").on("data", collect);
  const closed = once(child, "close");
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), OUTER_TIMEOUT_MS);
  });
  const result = await Promise.race([closed, expired]);
  clearTimeout(timer);
  if (result === null) return { timedOut: true, status: null, output };
  return { timedOut: false, status: result[0], output };
}

after(async () => {
  groups.forEach(killGroup);
  sleepPidFiles.forEach(killSleep);
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

test("a file with a live child process ends with exit 0 at the end of its tests", async () => {
  const result = await runFixture(FIXTURE_A, nodeTestArguments());
  assert.equal(result.timedOut, false, result.output);
  assert.equal(result.status, SUCCESS, result.output);
});

test("a file with a stop that never settles fails at the test timeout", async () => {
  const result = await runFixture(FIXTURE_B, nodeTestArguments());
  assert.equal(result.timedOut, false, result.output);
  assert.notEqual(result.status, SUCCESS, result.output);
  assert.match(result.output, new RegExp(`${FIXTURE_TIMEOUT_MS}ms`));
});

test("without --test-force-exit a file with a live child process reaches the outer timeout", async () => {
  const argumentsList = nodeTestArguments().filter(
    (argument) => argument !== FORCE_EXIT,
  );
  assert.ok(!argumentsList.includes(FORCE_EXIT));
  const result = await runFixture(FIXTURE_A, argumentsList);
  assert.equal(result.timedOut, true, result.output);
});
