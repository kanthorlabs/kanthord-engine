import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { temporary } from "../kernel/test-support.ts";
import { sshdPath, startTestSshd } from "./sshd-test-support.ts";

const SUPPORT_MODULE = fileURLToPath(
  new URL("./sshd-test-support.ts", import.meta.url),
);
const STOP_STEP_MS = 5000;
const STOP_LIMIT_MS = 10000;
const GONE_POLL_MS = 50;
const GONE_LIMIT_MS = 5000;
const CASE_TIMEOUT_MS = 30000;
const EXECUTABLE = 0o755;
const NO_PID = 0;
const GONE_CODE = "ESRCH";
const SUCCESS = 0;

function pidFileLine(pidFile: string): string {
  return `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`;
}

function fakeSshdSource(pidFile: string): string {
  return `#!/usr/bin/env node
${pidFileLine(pidFile)}
const { createServer } = require("node:net");
process.on("SIGTERM", () => {});
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
createServer((socket) => socket.end("SSH-2.0-fake\\n")).listen(port, "127.0.0.1");
`;
}

function wrapperSource(pidFile: string): string {
  return `#!/bin/sh
echo $$ > ${JSON.stringify(pidFile)}
exec ${JSON.stringify(sshdPath())} "$@"
`;
}

async function program(
  t: TestContext,
  source: (pidFile: string) => string,
): Promise<{ path: string; pidFile: string }> {
  const root = temporary(t);
  const path = join(root, "sshd-program");
  const pidFile = join(root, "sshd.pid");
  await writeFile(path, source(pidFile));
  await chmod(path, EXECUTABLE);
  return { path, pidFile };
}

async function pidOf(pidFile: string): Promise<number> {
  return Number((await readFile(pidFile, "utf8")).trim());
}

function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, GONE_CODE);
    return true;
  }
}

async function waitGone(pid: number): Promise<void> {
  const deadline = Date.now() + GONE_LIMIT_MS;
  while (!isGone(pid) && Date.now() < deadline) await delay(GONE_POLL_MS);
  assert.ok(isGone(pid), `The process ${pid} is still alive.`);
}

test(
  "the stop of the test sshd ends sshd",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const wrapper = await program(t, wrapperSource);
    let pid = NO_PID;
    await t.test("starts and stops sshd", async (subtest) => {
      await startTestSshd(subtest, wrapper.path);
      pid = await pidOf(wrapper.pidFile);
      assert.equal(isGone(pid), false);
    });
    assert.notEqual(pid, NO_PID);
    assert.equal(isGone(pid), true);
  },
);

test(
  "the stop of the test sshd kills an sshd that ignores SIGTERM",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const fake = await program(t, fakeSshdSource);
    let pid = NO_PID;
    let started = 0;
    await t.test("starts and stops the fake sshd", async (subtest) => {
      await startTestSshd(subtest, fake.path);
      pid = await pidOf(fake.pidFile);
      started = Date.now();
    });
    const elapsed = Date.now() - started;
    assert.notEqual(pid, NO_PID);
    assert.equal(isGone(pid), true);
    assert.ok(elapsed >= STOP_STEP_MS, `The stop took ${elapsed} ms.`);
    assert.ok(elapsed <= STOP_LIMIT_MS, `The stop took ${elapsed} ms.`);
  },
);

test(
  "the test sshd ends with a test process that exits before any stop",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const fake = await program(t, fakeSshdSource);
    const script = join(temporary(t), "leaking-process.ts");
    await writeFile(
      script,
      `import test from "node:test";
import { startTestSshd } from ${JSON.stringify(SUPPORT_MODULE)};
test("leaks sshd", async (t) => {
  await startTestSshd(t, process.argv[2]);
  process.exit(0);
});
`,
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [script, fake.path], {
      env,
      stdio: "ignore",
      signal: t.signal,
    });
    const [status] = await once(child, "close");
    assert.equal(status, SUCCESS);
    await waitGone(await pidOf(fake.pidFile));
  },
);
