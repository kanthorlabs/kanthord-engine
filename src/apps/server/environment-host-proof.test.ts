import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  classifyProof,
  EnvironmentFailureClass,
  type ProofInput,
  ProofPhase,
} from "../../project/environment-state.ts";
import { HostProofs } from "./environment-host-proof.ts";
import { threadEnvironment } from "./thread-driver.ts";

const RUN_ID = "RUN1";
const COMMIT = "commit";
const PASSING_COMMAND = "true";
const LIMIT_MS = 30000;
const GRANDCHILD_LIMIT_MS = 2000;
const TEST_TIMEOUT = 60000;
const POLL_MS = 50;
const POLL_LIMIT = 100;
const TAIL_LIMIT = 4096;
const ABSENT_EXIT = 127;
const RED_EXIT = 3;
const ONE_RESULT = 1;
const SOURCE: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: "/home/test",
  SECRET_TOKEN: "hidden",
};

function input(setup: string[], checks: string[]): ProofInput {
  return {
    run_id: RUN_ID,
    project_id: "project",
    binding_id: "binding",
    resource_identity: "resource",
    commit: COMMIT,
    setup,
    checks,
  };
}

function proofs(
  t: TestContext,
  options: {
    commandLimitMs?: number;
    onExport?: (directory: string, context: Context) => void;
  } = {},
) {
  const stateDirectory = temporary(t);
  const exported: { directory: string; commit: string }[] = [];
  const host = new HostProofs({
    stateDirectory,
    source: SOURCE,
    commandLimitMs: options.commandLimitMs ?? LIMIT_MS,
    async exportRepository(_binding, commit, directory, context) {
      exported.push({ directory, commit });
      writeFileSync(join(directory, "marker.txt"), "marker");
      options.onExport?.(directory, context);
    },
  });
  const runDirectory = join(stateDirectory, "environments", `run-${RUN_ID}`);
  return { host, stateDirectory, runDirectory, exported };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
    if (!alive(pid)) return true;
    await delay(POLL_MS);
  }
  return false;
}

test(
  "the checkout lands in the run directory and each command runs there",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host, runDirectory, exported } = proofs(t);
    const results = await host.proveOnHost(
      input(["pwd -P > ../setup.txt"], ["pwd -P && cat marker.txt"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(exported.length, ONE_RESULT);
    assert.equal(exported[0]!.commit, COMMIT);
    assert.equal(exported[0]!.directory, join(runDirectory, "checkout"));
    assert.equal(results[1]!.output.endsWith("marker"), true);
    assert.equal(
      results[1]!.output.split("\n")[0]!.endsWith("/run-RUN1/checkout"),
      true,
    );
  },
);

test(
  "a command gets the thread slot variables of the run directory only",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host, runDirectory } = proofs(t);
    const results = await host.proveOnHost(
      input([], ["env"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    const expected = threadEnvironment(SOURCE, runDirectory);
    const lines = results[0]!.output.split("\n").filter(Boolean);
    const actual = Object.fromEntries(
      lines.map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
    );
    for (const [name, value] of Object.entries(expected))
      assert.equal(actual[name], value, name);
    assert.equal(actual.SECRET_TOKEN, undefined);
    assert.equal(actual.XDG_CONFIG_HOME!.startsWith(runDirectory), true);
    assert.equal(
      Object.keys(actual).every(
        (name) =>
          name in expected || ["PWD", "SHLVL", "_", "OLDPWD"].includes(name),
      ),
      true,
    );
  },
);

test(
  "setup commands run before checks in order and results hold the fields",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host } = proofs(t);
    const results = await host.proveOnHost(
      input(
        ["printf a >> order.txt", "printf b >> order.txt"],
        ["cat order.txt", "printf c; exit 3"],
      ),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.deepEqual(results, [
      {
        phase: ProofPhase.Setup,
        command: "printf a >> order.txt",
        exit_code: 0,
        timed_out: false,
        output: "",
      },
      {
        phase: ProofPhase.Setup,
        command: "printf b >> order.txt",
        exit_code: 0,
        timed_out: false,
        output: "",
      },
      {
        phase: ProofPhase.Check,
        command: "cat order.txt",
        exit_code: 0,
        timed_out: false,
        output: "ab",
      },
      {
        phase: ProofPhase.Check,
        command: "printf c; exit 3",
        exit_code: 3,
        timed_out: false,
        output: "c",
      },
    ]);
  },
);

test(
  "the output keeps the last 4096 bytes",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host } = proofs(t);
    const results = await host.proveOnHost(
      input([], ["head -c 10000 /dev/zero | tr '\\0' x; printf END"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    const output = results[0]!.output;
    assert.equal(Buffer.byteLength(output), TAIL_LIMIT);
    assert.equal(output.endsWith("xEND"), true);
  },
);

test(
  "the first failed setup command ends the list",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host } = proofs(t);
    const results = await host.proveOnHost(
      input(["exit 3", "true"], ["true"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(results.length, ONE_RESULT);
    assert.equal(results[0]!.exit_code, RED_EXIT);
    assert.equal(
      classifyProof(results).class,
      EnvironmentFailureClass.SetupFailed,
    );
  },
);

test(
  "an absent command and a red check both appear in the results",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const { host } = proofs(t);
    const results = await host.proveOnHost(
      input([], ["command-that-does-not-exist", "exit 3"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.deepEqual(
      results.map((result) => result.exit_code),
      [ABSENT_EXIT, RED_EXIT],
    );
    assert.equal(
      classifyProof(results).class,
      EnvironmentFailureClass.CommandAbsent,
    );
  },
);

test(
  "a command over the limit answers timed_out and leaves no process",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const pidFile = join(temporary(t), "pid.txt");
    const { host, runDirectory } = proofs(t, {
      commandLimitMs: GRANDCHILD_LIMIT_MS,
    });
    const results = await host.proveOnHost(
      input([], [`sleep 30 & echo $! > ${pidFile}; wait`]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(results.length, ONE_RESULT);
    assert.equal(results[0]!.timed_out, true);
    assert.equal(existsSync(runDirectory), false);
    assert.equal(await gone(Number(readFileSync(pidFile, "utf8"))), true);
  },
);

test(
  "the grandchild of a timed out command is gone",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const stateDirectory = temporary(t);
    const pidFile = join(stateDirectory, "pid.txt");
    const host = new HostProofs({
      stateDirectory,
      source: SOURCE,
      commandLimitMs: GRANDCHILD_LIMIT_MS,
      async exportRepository() {},
    });
    const results = await host.proveOnHost(
      input([], [`sleep 30 & echo $! > ${pidFile}; wait`]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(results[0]!.timed_out, true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.equal(await gone(pid), true);
  },
);

test(
  "an aborted signal kills the process group and answers the results so far",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const stateDirectory = temporary(t);
    const pidFile = join(stateDirectory, "pid.txt");
    const controller = new AbortController();
    const host = new HostProofs({
      stateDirectory,
      source: SOURCE,
      commandLimitMs: LIMIT_MS,
      async exportRepository() {},
    });
    const pending = host.proveOnHost(
      input(
        [],
        [
          PASSING_COMMAND,
          `sleep 30 & echo $! > ${pidFile}; wait`,
          PASSING_COMMAND,
        ],
      ),
      controller.signal,
    );
    for (let attempt = 0; attempt < POLL_LIMIT; attempt += 1) {
      if (existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) break;
      await delay(POLL_MS);
    }
    controller.abort();
    const results = await pending;
    assert.equal(results.length, ONE_RESULT);
    assert.equal(results[0]!.command, PASSING_COMMAND);
    assert.equal(await gone(Number(readFileSync(pidFile, "utf8"))), true);
    assert.deepEqual(readdirSync(join(stateDirectory, "environments")), []);
  },
);

test(
  "the run directory is gone after a pass and after a failure",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const passing = proofs(t);
    await passing.host.proveOnHost(
      input([], ["printf x > made.txt"]),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(existsSync(passing.runDirectory), false);
    const failing = proofs(t);
    await failing.host.proveOnHost(
      input(["exit 3"], []),
      AbortSignal.timeout(LIMIT_MS),
    );
    assert.equal(existsSync(failing.runDirectory), false);
  },
);

test(
  "the run directory is gone after an export failure",
  { timeout: TEST_TIMEOUT },
  async (t) => {
    const stateDirectory = temporary(t);
    const host = new HostProofs({
      stateDirectory,
      source: SOURCE,
      commandLimitMs: LIMIT_MS,
      async exportRepository() {
        throw new Error("export failed");
      },
    });
    await assert.rejects(
      host.proveOnHost(input([], ["true"]), AbortSignal.timeout(LIMIT_MS)),
      /export failed/,
    );
    assert.equal(
      existsSync(join(stateDirectory, "environments", "run-RUN1")),
      false,
    );
  },
);
