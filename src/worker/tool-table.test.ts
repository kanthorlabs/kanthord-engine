import assert from "node:assert/strict";
import { unusedHostTools } from "./test-support.ts";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BashToolOptions } from "@earendil-works/pi-coding-agent";
import { temporary } from "../kernel/test-support.ts";
import { ExecutionBudget } from "./budget.ts";
import { loadPi } from "../agent/pi.ts";
import {
  checkAgentTools,
  childEnvironment,
  sessionTools,
  toolDeclarations,
  ToolSource,
} from "./tool-table.ts";

test("native tool declarations preserve the catalog allowlists", async () => {
  const objectType = "object";
  const swe = await toolDeclarations("swe@1");
  const reviewer = await toolDeclarations("re@1");
  assert.deepEqual(
    swe.map(({ name }) => name),
    ["read", "edit", "write", "grep", "find", "ls", "bash", "evidence-upload"],
  );
  assert.deepEqual(
    reviewer.map(({ name }) => name),
    ["read", "grep", "find", "ls"],
  );
  assert.equal(swe.at(-1)!.source, ToolSource.Host);
  for (const declaration of [...swe.slice(0, -1), ...reviewer]) {
    assert.equal(declaration.source, ToolSource.Builtin);
    assert.equal(declaration.input_schema.type, objectType);
  }
});

test("child environment removes provider keys and bash timeout stays below the budget", async (t) => {
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
  sessionTools(mockPi, "swe@1", cwd, budget, unusedHostTools);
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
  sessionTools(mockPi, "swe@1", cwd, ended, unusedHostTools);
  await assert.rejects(
    captured!.operations!.exec("true", cwd, { onData: () => {} }),
    /resource budget ended/,
  );
  assert.deepEqual(
    sessionTools(pi, "re@1", cwd, budget, unusedHostTools).customTools,
    [],
  );
  sessionTools(
    { ...mockPi, createLocalBashOperations: pi.createLocalBashOperations },
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
  );
  const output = await captured!.operations!.exec(
    'test -z "$ANTHROPIC_API_KEY"',
    cwd,
    { env, onData: () => {} },
  );
  assert.deepEqual(output, { exitCode: 0 });
});

test("host tools require working rg and prefer fd over fdfind", (t) => {
  const path = temporary(t);
  const previous = process.env.PATH;
  process.env.PATH = path;
  t.after(() => {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  });
  assert.throws(checkAgentTools, { code: "worker.start.tool_missing" });
  for (const name of ["rg", "fdfind"])
    writeFileSync(join(path, name), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.doesNotThrow(checkAgentTools);
  writeFileSync(join(path, "fd"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  assert.throws(checkAgentTools, { code: "worker.start.tool_missing" });
});
