import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { test, type TestContext } from "node:test";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { COMMAND_LIMIT_MS, ExecutionBudget } from "./budget.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "../../agent/test-support.ts";
import { childEnvironment, sessionTools, ToolProcesses } from "./tool-table.ts";

const MILLISECONDS_PER_SECOND = 1000;
const MODEL_TIMEOUT_SECONDS = 30;
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

test("child environment removes provider keys and bash timeout stays below the budget and the command limit", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    PATH: "/bin",
    SSH_AUTH_SOCK: "socket",
  };
  assert.deepEqual(childEnvironment(env), { PATH: "/bin" });
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
  const now = Date.now();
  const budget = new ExecutionBudget({
    created_at: now,
    expired_at: now + 10000,
    resource_budget: { wall_time_ms: 5000 },
  });
  const cwd = temporary(t);
  const tools = (executionBudget: ExecutionBudget) =>
    sessionTools(
      mockPi,
      "swe@1",
      cwd,
      executionBudget,
      unusedHostTools,
      hostEnvironment(),
      recording,
    );
  await runBash(tools(budget), "true", 3600);
  const maximumSeconds = 4;
  assert.ok(recording.timeout! <= maximumSeconds);
  assert.deepEqual(captured!.spawnHook!({ command: "true", cwd, env }).env, {
    PATH: "/bin",
  });
  assert.equal(captured!.exposeSessionEnvironment, false);
  const ended = new ExecutionBudget({
    created_at: now - 10000,
    expired_at: now + 10000,
    resource_budget: { wall_time_ms: 1 },
  });
  await assert.rejects(runBash(tools(ended), "true"), /resource budget ended/);
  const long = new ExecutionBudget({
    created_at: now,
    expired_at: now + 7200000,
    resource_budget: { wall_time_ms: 7200000 },
  });
  await runBash(tools(long), "true");
  assert.ok(recording.timeout! < COMMAND_LIMIT_MS / MILLISECONDS_PER_SECOND);
  await runBash(tools(long), "true", MODEL_TIMEOUT_SECONDS);
  assert.equal(recording.timeout, MODEL_TIMEOUT_SECONDS);
  assert.deepEqual(
    sessionTools(
      pi,
      "re@1",
      cwd,
      budget,
      unusedHostTools,
      hostEnvironment(),
      recording,
    ).customTools,
    [],
  );
  const processes = new ToolProcesses(pi.getShellConfig());
  const real = sessionTools(
    mockPi,
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
    hostEnvironment(),
    processes,
  );
  await runBash(real, "true");
  const output = await captured!.operations!.exec(
    'test -z "$ANTHROPIC_API_KEY"',
    cwd,
    { env, onData: () => {} },
  );
  assert.deepEqual(output, { exitCode: 0 });
  assert.equal(processes.take(TOOL_CALL)?.killed, false);
  assert.equal(processes.take(TOOL_CALL), undefined);
});

const TREE_TIMEOUT_SECONDS = 20;

async function killedBashCall(
  t: TestContext,
  timeout: number | undefined,
  controller: AbortController | undefined,
): Promise<{ message: string; spawned: number[]; ready: boolean }> {
  const pi = await loadPi();
  let ready = false;
  const cwd = temporary(t);
  const now = Date.now();
  const budget = new ExecutionBudget({
    created_at: now,
    expired_at: now + COMMAND_LIMIT_MS,
    resource_budget: { wall_time_ms: COMMAND_LIMIT_MS },
  });
  const [bash] = sessionTools(
    pi,
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
    hostEnvironment(),
    new ToolProcesses(pi.getShellConfig()),
  ).customTools;
  const failure: Error = await bash!
    .execute(
      TOOL_CALL,
      { command: processTreeCommand(), ...(timeout ? { timeout } : {}) },
      controller?.signal,
      (update) => {
        if (pidsIn(update.content).length !== PROCESS_TREE_PIDS) return;
        ready = true;
        controller?.abort();
      },
      undefined as never,
    )
    .then(
      () => assert.fail("the bash call ended without a kill"),
      (error: Error) => error,
    );
  return {
    message: failure.message,
    spawned: spawnedPids(t, [{ type: "text", text: failure.message }]),
    ready,
  };
}

test("a bash call that times out leaves no process of its tree, also a process in its own group", async (t) => {
  const { message, spawned, ready } = await killedBashCall(
    t,
    TREE_TIMEOUT_SECONDS,
    undefined,
  );
  assert.ok(ready, "the process tree did not start before the timeout");
  assert.match(message, /Command timed out after 20 seconds/);
  assert.equal(spawned.length, PROCESS_TREE_PIDS);
  assert.deepEqual(await survivingProcesses(spawned), []);
});

test("an aborted bash call leaves no process of its tree, also a process in its own group", async (t) => {
  const { message, spawned } = await killedBashCall(
    t,
    undefined,
    new AbortController(),
  );
  assert.match(message, /Command aborted/);
  assert.equal(spawned.length, PROCESS_TREE_PIDS);
  assert.deepEqual(await survivingProcesses(spawned), []);
});
