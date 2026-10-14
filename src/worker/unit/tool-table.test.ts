import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { test } from "node:test";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { COMMAND_LIMIT_MS, ExecutionBudget } from "./budget.ts";
import { loadPi } from "../../agent/pi.ts";
import { childEnvironment, sessionTools } from "./tool-table.ts";

const MILLISECONDS_PER_SECOND = 1000;
const MODEL_TIMEOUT_SECONDS = 30;

test("child environment removes provider keys and bash timeout stays below the budget and the command limit", async (t) => {
  const env = {
    ANTHROPIC_API_KEY: "secret",
    OPENAI_API_KEY: "secret",
    ANTHROPIC_AUTH_TOKEN: "secret",
    PATH: "/bin",
    SSH_AUTH_SOCK: "socket",
  };
  assert.deepEqual(childEnvironment(env), {
    PATH: "/bin",
    SSH_AUTH_SOCK: "socket",
  });
  const pi = await loadPi();
  let captured: BashToolOptions | undefined;
  let timeout: number | undefined;
  const mockPi = {
    ...pi,
    createBashToolDefinition: (cwd: string, options?: BashToolOptions) => {
      captured = options;
      return pi.createBashToolDefinition(cwd, options);
    },
    createLocalBashOperations: () => ({
      exec: async (
        _command: string,
        _cwd: string,
        options: { timeout?: number },
      ) => {
        timeout = options.timeout;
        return { exitCode: 0 };
      },
    }),
  };
  const now = Date.now();
  const budget = new ExecutionBudget({
    created_at: now,
    expired_at: now + 10000,
    resource_budget: { wall_time_ms: 5000 },
  });
  const cwd = temporary(t);
  sessionTools(
    mockPi,
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
    hostEnvironment(),
  );
  await captured!.operations!.exec("true", cwd, {
    timeout: 3600,
    onData: () => {},
  });
  const maximumSeconds = 4;
  assert.ok(timeout! <= maximumSeconds);
  assert.deepEqual(captured!.spawnHook!({ command: "true", cwd, env }).env, {
    PATH: "/bin",
    SSH_AUTH_SOCK: "socket",
  });
  assert.equal(captured!.exposeSessionEnvironment, false);
  const ended = new ExecutionBudget({
    created_at: now - 10000,
    expired_at: now + 10000,
    resource_budget: { wall_time_ms: 1 },
  });
  sessionTools(mockPi, "swe@1", cwd, ended, unusedHostTools, hostEnvironment());
  await assert.rejects(
    captured!.operations!.exec("true", cwd, { onData: () => {} }),
    /resource budget ended/,
  );
  const long = new ExecutionBudget({
    created_at: now,
    expired_at: now + 7200000,
    resource_budget: { wall_time_ms: 7200000 },
  });
  sessionTools(mockPi, "swe@1", cwd, long, unusedHostTools, hostEnvironment());
  await captured!.operations!.exec("true", cwd, { onData: () => {} });
  assert.ok(timeout! < COMMAND_LIMIT_MS / MILLISECONDS_PER_SECOND);
  await captured!.operations!.exec("true", cwd, {
    timeout: MODEL_TIMEOUT_SECONDS,
    onData: () => {},
  });
  assert.equal(timeout, MODEL_TIMEOUT_SECONDS);
  assert.deepEqual(
    sessionTools(pi, "re@1", cwd, budget, unusedHostTools, hostEnvironment())
      .customTools,
    [],
  );
  sessionTools(
    { ...mockPi, createLocalBashOperations: pi.createLocalBashOperations },
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
    hostEnvironment(),
  );
  const output = await captured!.operations!.exec(
    'test -z "$ANTHROPIC_API_KEY"',
    cwd,
    { env, onData: () => {} },
  );
  assert.deepEqual(output, { exitCode: 0 });
});
