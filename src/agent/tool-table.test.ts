import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { temporary } from "../kernel/test-support.ts";
import { loadPi } from "./pi.ts";
import { childEnvironment } from "./environment.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "./test-support.ts";
import { COMMAND_LIMIT_MS, sessionTools, ToolProcesses } from "./tool-table.ts";
import { WallTimer } from "./run-budget.ts";

const MILLISECONDS_PER_SECOND = 1000;
const TOOL_CALL = "call_bash";

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

test("child environment holds only childEnvironment names plus the shell PATH, a name of process.env absent from the input is absent from the child, and the command limit with a null deadline is COMMAND_LIMIT_MS", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "secret",
    PATH: "/usr/bin",
    SSH_AUTH_SOCK: "socket",
  };
  assert.deepEqual(childEnvironment(env), { PATH: "/usr/bin" });

  const pi = await loadPi();
  let captured: BashToolOptions | undefined;
  const mockPi = {
    ...pi,
    createBashToolDefinition: (cwd: string, options?: BashToolOptions) => {
      captured = options;
      return pi.createBashToolDefinition(cwd, options);
    },
  };
  const recording = new RecordingProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const budget = new WallTimer(null);

  const tools = sessionTools(mockPi, "swe@1", {
    cwd,
    budget,
    env,
    processes: recording,
  });

  await runBash(tools, "true");
  assert.ok(recording.timeout! < COMMAND_LIMIT_MS / MILLISECONDS_PER_SECOND);
  assert.equal(
    Math.min(budget.remainingMs(), COMMAND_LIMIT_MS),
    COMMAND_LIMIT_MS,
  );

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
        spawned = spawnedPids(t, update.content);
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
