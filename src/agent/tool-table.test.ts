import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { overrideEnvironment, temporary } from "../kernel/test-support.ts";
import { loadPi } from "./pi.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  survivingProcesses,
} from "./test-support.ts";
import {
  COMMAND_LIMIT_MS,
  sessionTools,
  type ToolBudget,
  ToolProcesses,
} from "./tool-table.ts";
import { WallTimer } from "./run-budget.ts";

const TOOL_CALL = "call_bash";
const TEXT_PART = "text";
const KEPT_NAME = "KANTHORD_TEST_KEPT";
const KEPT_VALUE = "kept";
const PROCESS_ONLY_NAME = "KANTHORD_TEST_PROCESS_ONLY";
const PROCESS_ONLY_VALUE = "process";

class RecordingProcesses extends ToolProcesses {
  timeout: number | undefined;

  override operations(toolCallId: string): BashOperations {
    assert.ok(toolCallId);
    return {
      exec: async (_command, _cwd, options) => {
        this.timeout = options.timeout;
        return { exitCode: 0 };
      },
    };
  }
}

function runBash(
  tools: { customTools: ToolDefinition[] },
  command: string,
  timeout?: number,
) {
  const [bash] = tools.customTools;
  assert.ok(bash);
  return bash.execute(
    TOOL_CALL,
    { command, ...(timeout === undefined ? {} : { timeout }) },
    undefined,
    undefined,
    undefined as never,
  );
}

async function appliedTimeout(t: TestContext, budget: ToolBudget) {
  const pi = await loadPi();
  const recording = new RecordingProcesses(pi.getShellConfig());
  const tools = sessionTools(pi, "swe@1", {
    cwd: temporary(t),
    budget,
    env: {},
    processes: recording,
  });
  await runBash(tools, "true");
  assert.ok(recording.timeout !== undefined);
  return recording.timeout;
}

test("the command limit with a null deadline is COMMAND_LIMIT_MS", async (t) => {
  const capped = await appliedTimeout(t, {
    remainingMs: () => COMMAND_LIMIT_MS,
  });
  assert.equal(await appliedTimeout(t, new WallTimer(null)), capped);
  assert.equal(
    await appliedTimeout(t, { remainingMs: () => COMMAND_LIMIT_MS * 2 }),
    capped,
  );
  assert.ok(
    (await appliedTimeout(t, { remainingMs: () => COMMAND_LIMIT_MS / 2 })) <
      capped,
  );
});

test("a child process gets only the names of childEnvironment, less the removed names, plus the pi PATH", async (t) => {
  overrideEnvironment(t, { [PROCESS_ONLY_NAME]: PROCESS_ONLY_VALUE });
  const pi = await loadPi();
  const [bash] = sessionTools(pi, "swe@1", {
    cwd: temporary(t),
    budget: new WallTimer(null),
    env: {
      [KEPT_NAME]: KEPT_VALUE,
      ANTHROPIC_API_KEY: "secret",
      SSH_AUTH_SOCK: "socket",
    },
    processes: new ToolProcesses(pi.getShellConfig()),
  }).customTools;
  assert.ok(bash);
  const result = await bash.execute(
    TOOL_CALL,
    { command: "env" },
    undefined,
    undefined,
    undefined as never,
  );
  const names = new Set(
    result.content
      .map((part) => (part.type === TEXT_PART ? part.text : ""))
      .join("")
      .split("\n")
      .map((line) => line.split("=")[0]),
  );
  assert.ok(names.has(KEPT_NAME));
  assert.ok(names.has("PATH"));
  assert.ok(!names.has(PROCESS_ONLY_NAME));
  assert.ok(!names.has("ANTHROPIC_API_KEY"));
  assert.ok(!names.has("SSH_AUTH_SOCK"));
});

test("the spawn hook replaces the environment of pi with the input names and the pi PATH", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "secret",
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "socket",
  };
  const pi = await loadPi();
  let captured: BashToolOptions | undefined;
  const mockPi = {
    ...pi,
    createBashToolDefinition: (cwd: string, options?: BashToolOptions) => {
      captured = options;
      return pi.createBashToolDefinition(cwd, options);
    },
  };
  const cwd = temporary(t);
  const tools = sessionTools(mockPi, "swe@1", {
    cwd,
    budget: new WallTimer(null),
    env,
    processes: new RecordingProcesses(pi.getShellConfig()),
  });

  await runBash(tools, "true");

  assert.deepEqual(
    captured!.spawnHook!({
      command: "true",
      cwd,
      env: { PATH: "/usr/bin", PROCESS_ENV_ONLY: "absent" },
    }).env,
    { PATH: "/usr/bin" },
  );
  assert.equal(captured!.exposeSessionEnvironment, false);
});

async function killedBashCall(
  t: TestContext,
): Promise<{ spawned: number[]; ready: boolean }> {
  const pi = await loadPi();
  const processes = new ToolProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const budget = new WallTimer(null);
  const [bash] = sessionTools(pi, "swe@1", {
    cwd,
    budget,
    env: {},
    processes,
  }).customTools;
  assert.ok(bash);

  let ready = false;
  let spawned: number[] = [];

  await bash
    .execute(
      TOOL_CALL,
      { command: processTreeCommand() },
      undefined,
      (update) => {
        if (pidsIn(update.content).length !== PROCESS_TREE_PIDS) return;
        spawned = pidsIn(update.content);
        ready = true;
        processes.killAll();
      },
      undefined as never,
    )
    .then(
      () => {},
      () => {},
    );

  return { spawned, ready };
}

test("killAll kills each live process tree", async (t) => {
  const { spawned, ready } = await killedBashCall(t);
  assert.ok(ready, "process tree did not start before killAll");
  assert.equal(spawned.length, PROCESS_TREE_PIDS);
  assert.deepEqual(await survivingProcesses(spawned), []);
});
