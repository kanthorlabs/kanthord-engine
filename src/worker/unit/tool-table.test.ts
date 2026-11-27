import assert from "node:assert/strict";
import { join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { unusedHostTools } from "./test-support.ts";
import { test, type TestContext } from "node:test";
import type {
  BashOperations,
  BashToolOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  hostEnvironment,
  overrideEnvironment,
  temporary,
} from "../../kernel/test-support.ts";
import { COMMAND_LIMIT_MS, ExecutionBudget } from "./budget.ts";
import { bashSandbox, createBashSandbox } from "../../agent/bash-sandbox.ts";
import { loadPi } from "../../agent/pi.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "../../agent/test-support.ts";
import { childEnvironment, sessionTools, ToolProcesses } from "./tool-table.ts";
import { HOST_TOOL_PARAMETERS } from "../../agent/catalog.ts";
import { HostTool } from "../contract.ts";
import { VerificationWrites } from "./verification-writes.ts";
import { simpleGit } from "simple-git";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { background } from "../../kernel/context.ts";

const MILLISECONDS_PER_SECOND = 1000;
const MODEL_TIMEOUT_SECONDS = 30;
const TOOL_CALL = "call_bash";
const TEMPORARY_FALLBACK = "/tmp";
const COMMAND = "echo coder";
const SINGLE_CALL = 1;

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

class CallRecordingProcesses extends ToolProcesses {
  readonly operationIds: string[] = [];
  readonly calls: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv | undefined;
  }[] = [];

  override operations(toolCallId: string): BashOperations {
    assert.ok(toolCallId);
    this.operationIds.push(toolCallId);
    return {
      exec: async (command, cwd, options) => {
        this.calls.push({ command, cwd, env: options.env });
        return { exitCode: 0 };
      },
    };
  }
}

function packageCacheExports(temporaryDirectory: string): string {
  return [
    `pnpm_config_store_dir='${join(temporaryDirectory, "pnpm-store")}'`,
    `pnpm_config_cache_dir='${join(temporaryDirectory, "pnpm-cache")}'`,
    `npm_config_cache='${join(temporaryDirectory, "npm-cache")}'`,
  ].join(" ");
}

function unwrapped(t: TestContext) {
  t.mock.method(bashSandbox, "wrap", async (command: string) => command);
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
  unwrapped(t);
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
      { denyRead: [] },
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
      { denyRead: [] },
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
    { denyRead: [] },
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

test("sessionTools of swe@1 holds both host tools under their own names and re@1 holds none", async (t) => {
  const pi = await loadPi();
  const processes = new ToolProcesses(pi.getShellConfig());
  const now = Date.now();
  const budget = new ExecutionBudget({
    created_at: now,
    expired_at: now + 10000,
    resource_budget: { wall_time_ms: 5000 },
  });
  const tools = (agent: string) =>
    sessionTools(
      pi,
      agent,
      temporary(t),
      budget,
      unusedHostTools,
      hostEnvironment(),
      processes,
      { denyRead: [] },
    );
  const names = Object.values(HostTool);
  const swe = tools("swe@1");
  for (const name of names) assert.ok(swe.allowlist.includes(name), name);
  const hosts = swe.customTools.filter((tool) =>
    (names as string[]).includes(tool.name),
  );
  assert.deepEqual(hosts.map((tool) => tool.name).sort(), [...names].sort());
  for (const tool of hosts)
    assert.deepEqual(
      JSON.stringify(tool.parameters),
      JSON.stringify(HOST_TOOL_PARAMETERS[tool.name as HostTool]),
    );
  const reviewer = tools("re@1");
  assert.deepEqual(reviewer.customTools, []);
  for (const name of names)
    assert.equal(reviewer.allowlist.includes(name), false);
});

test("bash records the requested and the applied timeout once and records nothing for a rejected exec", async (t) => {
  unwrapped(t);
  const pi = await loadPi();
  const processes = new RecordingProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const now = Date.now();
  const budget = (wallTimeMs: number, createdAt: number) =>
    new ExecutionBudget({
      created_at: createdAt,
      expired_at: now + wallTimeMs,
      resource_budget: { wall_time_ms: wallTimeMs },
    });
  const tools = (executionBudget: ExecutionBudget) =>
    sessionTools(
      pi,
      "swe@1",
      cwd,
      executionBudget,
      unusedHostTools,
      hostEnvironment(),
      processes,
      { denyRead: [] },
    );
  const long = budget(COMMAND_LIMIT_MS * 2, now);
  const limitSeconds = COMMAND_LIMIT_MS / MILLISECONDS_PER_SECOND - 1;
  const requestedSeconds = COMMAND_LIMIT_MS;
  await runBash(tools(long), "true", requestedSeconds);
  assert.deepEqual(processes.takeTimeout(TOOL_CALL), {
    requestedMs: requestedSeconds * MILLISECONDS_PER_SECOND,
    appliedMs: limitSeconds * MILLISECONDS_PER_SECOND,
  });
  assert.equal(processes.takeTimeout(TOOL_CALL), undefined);
  await runBash(tools(long), "true");
  assert.deepEqual(processes.takeTimeout(TOOL_CALL), {
    requestedMs: null,
    appliedMs: limitSeconds * MILLISECONDS_PER_SECOND,
  });
  const ended = budget(1, now - 10000);
  await assert.rejects(runBash(tools(ended), "true"), /resource budget ended/);
  assert.equal(processes.takeTimeout(TOOL_CALL), undefined);
});

test("the bash tool of swe@1 runs its command through the exec of ToolProcesses.operations with the child environment", async (t) => {
  unwrapped(t);
  const pi = await loadPi();
  const processes = new CallRecordingProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const now = Date.now();
  const budget = new ExecutionBudget({
    created_at: now,
    expired_at: now + COMMAND_LIMIT_MS,
    resource_budget: { wall_time_ms: COMMAND_LIMIT_MS },
  });
  const removed = ["ANTHROPIC_API_KEY", "KANTHORD_TOKEN"];
  const source = {
    ...hostEnvironment(),
    ...Object.fromEntries(removed.map((name) => [name, "present"])),
  };
  const tools = sessionTools(
    pi,
    "swe@1",
    cwd,
    budget,
    unusedHostTools,
    source,
    processes,
    { denyRead: [] },
  );
  await runBash(tools, COMMAND);
  assert.deepEqual(processes.operationIds, [TOOL_CALL]);
  assert.equal(processes.calls.length, SINGLE_CALL);
  const [call] = processes.calls;
  assert.ok(call?.env);
  assert.equal(call.command, COMMAND);
  assert.equal(call.cwd, cwd);
  for (const name of removed) assert.ok(!(name in call.env));
  assert.deepEqual(call.env, childEnvironment(call.env));
});

function fakeSandboxRuntime() {
  const customConfigs: Partial<SandboxRuntimeConfig>[] = [];
  return {
    customConfigs,
    runtime: {
      initialize: async () => {},
      reset: async () => {},
      cleanupAfterCommand: () => {},
      wrapWithSandbox: async (
        command: string,
        _binShell?: string,
        customConfig: (typeof customConfigs)[number] = {},
      ) => {
        customConfigs.push(customConfig);
        return `sandboxed ${command}`;
      },
    },
  };
}

function sandboxedTools(
  pi: Awaited<ReturnType<typeof loadPi>>,
  options: {
    processes: ToolProcesses;
    cwd: string;
    env: NodeJS.ProcessEnv;
    denyRead: string[];
  },
) {
  const now = Date.now();
  return sessionTools(
    pi,
    "swe@1",
    options.cwd,
    new ExecutionBudget({
      created_at: now,
      expired_at: now + COMMAND_LIMIT_MS,
      resource_budget: { wall_time_ms: COMMAND_LIMIT_MS },
    }),
    unusedHostTools,
    options.env,
    options.processes,
    { denyRead: options.denyRead },
  );
}

test("the swe@1 bash runs the wrapped command in the workspace with the TMPDIR of the environment in allowWrite", async (t) => {
  overrideEnvironment(t, { HOME: temporary(t) });
  const pi = await loadPi();
  const fake = fakeSandboxRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  t.mock.method(bashSandbox, "wrap", sandbox.wrap);
  const processes = new CallRecordingProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const tmp = hostEnvironment().TMPDIR ?? TEMPORARY_FALLBACK;
  const denyRead = ["/credential/directory"];
  const tools = sandboxedTools(pi, {
    processes,
    cwd,
    env: hostEnvironment(),
    denyRead,
  });
  await runBash(tools, COMMAND);
  assert.equal(processes.calls.length, SINGLE_CALL);
  assert.equal(
    processes.calls[0]?.command,
    `export KANTHORD_BASH_COMMAND='${COMMAND}' KANTHORD_BASH_TMPDIR='${tmp}' TMPDIR='${tmp}' ${packageCacheExports(tmp)}; sandboxed export TMPDIR="$KANTHORD_BASH_TMPDIR"; eval "$KANTHORD_BASH_COMMAND"`,
  );
  assert.equal(processes.calls[0]?.cwd, cwd);
  assert.deepEqual(fake.customConfigs[0]?.filesystem?.allowWrite, [cwd, tmp]);
  assert.deepEqual(fake.customConfigs[0]?.filesystem?.denyRead, [
    ...denyRead,
    hostEnvironment().HOME,
  ]);
});

test("the swe@1 bash exports the package store and the package cache under the TMPDIR of the environment in the wrapped command", async (t) => {
  const pi = await loadPi();
  const fake = fakeSandboxRuntime();
  const sandbox = createBashSandbox(fake.runtime, "linux");
  t.mock.method(bashSandbox, "wrap", sandbox.wrap);
  let captured: BashToolOptions | undefined;
  const mockPi = {
    ...pi,
    createBashToolDefinition: (cwd: string, options?: BashToolOptions) => {
      captured = options;
      return pi.createBashToolDefinition(cwd, options);
    },
  };
  const processes = new CallRecordingProcesses(pi.getShellConfig());
  const cwd = temporary(t);
  const tmp = temporary(t);
  overrideEnvironment(t, { HOME: temporary(t) });
  const tools = sandboxedTools(mockPi, {
    processes,
    cwd,
    env: hostEnvironment(),
    denyRead: [],
  });
  await runBash(tools, COMMAND);
  await captured!.operations!.exec(COMMAND, cwd, {
    env: { ...hostEnvironment(), TMPDIR: tmp },
    onData: () => {},
  });
  assert.equal(
    processes.calls.at(-1)?.command,
    `export KANTHORD_BASH_COMMAND='${COMMAND}' KANTHORD_BASH_TMPDIR='${tmp}' TMPDIR='${tmp}' ${packageCacheExports(tmp)}; sandboxed export TMPDIR="$KANTHORD_BASH_TMPDIR"; eval "$KANTHORD_BASH_COMMAND"`,
  );
});

test("(security) a rejected wrap rejects the bash call, spawns no process and records no timeout", async (t) => {
  const pi = await loadPi();
  t.mock.method(bashSandbox, "wrap", async () => {
    throw new Error("the bash sandbox is not available: bubblewrap is missing");
  });
  const processes = new CallRecordingProcesses(pi.getShellConfig());
  const tools = sandboxedTools(pi, {
    processes,
    cwd: temporary(t),
    env: hostEnvironment(),
    denyRead: [],
  });
  await assert.rejects(
    runBash(tools, COMMAND),
    /the bash sandbox is not available: bubblewrap is missing/,
  );
  assert.deepEqual(processes.calls, []);
  assert.equal(processes.takeTimeout(TOOL_CALL), undefined);
});

const TREE_TIMEOUT_SECONDS = 20;

async function killedBashCall(
  t: TestContext,
  timeout: number | undefined,
  controller: AbortController | undefined,
): Promise<{ message: string; spawned: number[]; ready: boolean }> {
  unwrapped(t);
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
    { denyRead: [] },
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

const F79_CASE_TIMEOUT_MS = 30_000;

test(
  "F79 path 4: the abort that NativeAgent.dispose() raises kills the tree of a running bash call at once",
  { timeout: F79_CASE_TIMEOUT_MS },
  async (t) => {
    unwrapped(t);
    const pi = await loadPi();
    const now = Date.now();
    const budget = new ExecutionBudget({
      created_at: now,
      expired_at: now + COMMAND_LIMIT_MS,
      resource_budget: { wall_time_ms: COMMAND_LIMIT_MS },
    });
    const [bash] = sessionTools(
      pi,
      "swe@1",
      temporary(t),
      budget,
      unusedHostTools,
      hostEnvironment(),
      new ToolProcesses(pi.getShellConfig()),
      { denyRead: [] },
    ).customTools;
    const controller = new AbortController();
    const ready = Promise.withResolvers<number[]>();
    const running = bash!.execute(
      TOOL_CALL,
      { command: processTreeCommand() },
      controller.signal,
      (update) => {
        const pids = pidsIn(update.content);
        if (pids.length === PROCESS_TREE_PIDS) ready.resolve(pids);
      },
      undefined as never,
    );
    const settled = running.then(
      () => undefined,
      (error: Error) => error,
    );
    const spawned = spawnedPids(t, [
      { type: "text", text: (await ready.promise).join("\n") },
    ]);
    controller.abort();
    assert.deepEqual(await survivingProcesses(spawned), []);
    assert.match((await settled)?.message ?? "", /Command aborted/);
  },
);

const VERIFY = "sh check.sh";
const PYC = "pkg/__pycache__/check.pyc";
const WRITE_PYC =
  "mkdir -p pkg/__pycache__ && echo cache > pkg/__pycache__/check.pyc";
const FAILING_EXIT = 3;
const FAILING_OUTPUT = "verification-output\n";
const NOTE_CONTENT = "note";
const UNTRACKED_CONTENT = "untracked";
const TRACKED_CONTENT = "tracked content";
const ROOT_USER = 0;

async function verificationCheckout(
  t: TestContext,
  script: string,
  extra: Record<string, string> = {},
) {
  unwrapped(t);
  const directory = temporary(t);
  const git = simpleGit(directory);
  await git.init();
  await git.addConfig("user.name", "Test");
  await git.addConfig("user.email", "test@example.invalid");
  writeFileSync(join(directory, ".gitignore"), "/__pycache__\n");
  writeFileSync(join(directory, "check.sh"), script);
  writeFileSync(join(directory, "tracked"), TRACKED_CONTENT);
  for (const [name, content] of Object.entries(extra))
    writeFileSync(join(directory, name), content);
  mkdirSync(join(directory, "pkg"));
  await git.add("--all");
  await git.commit("initial");
  const pi = await loadPi();
  const writes = new VerificationWrites({
    commands: [VERIFY],
    checkouts: [directory],
    env: hostEnvironment(),
    context: background,
    workspace: directory,
  });
  const now = Date.now();
  const tools = sessionTools(
    pi,
    "swe@1",
    directory,
    new ExecutionBudget({
      created_at: now,
      expired_at: now + COMMAND_LIMIT_MS,
      resource_budget: { wall_time_ms: COMMAND_LIMIT_MS },
    }),
    unusedHostTools,
    hostEnvironment(),
    new ToolProcesses(pi.getShellConfig()),
    { denyRead: [] },
    writes,
  );
  return { directory, git, writes, tools };
}

test("(F90) a verification run records the new untracked path that the ignore rules do not match and keeps the file", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(t, WRITE_PYC);
  await runBash(tools, VERIFY);
  assert.deepEqual(writes.pathsOf(directory), [PYC]);
  assert.equal(existsSync(join(directory, PYC)), true);
});

test("a command that holds a verification command as a part is no verification run", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(t, WRITE_PYC);
  await runBash(tools, `cd pkg && ${VERIFY}`);
  assert.deepEqual(writes.pathsOf(directory), []);
});

test("a verification command with outer spaces is a verification run", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(t, WRITE_PYC);
  await runBash(tools, `  ${VERIFY}  `);
  assert.deepEqual(writes.pathsOf(directory), [PYC]);
});

test("a bash call that is no verification records no write", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(
    t,
    WRITE_PYC,
    { "generate.sh": "echo generated > gen.ts" },
  );
  await runBash(tools, "sh generate.sh");
  assert.equal(existsSync(join(directory, "gen.ts")), true);
  assert.deepEqual(writes.pathsOf(directory), []);
});

test("a bash call that is no verification and changes a recorded path removes the path from the record", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(
    t,
    `${WRITE_PYC}; mkdir -p gen && echo out > gen/out.txt`,
  );
  await runBash(tools, VERIFY);
  assert.deepEqual(writes.pathsOf(directory), ["gen/out.txt", PYC]);
  await runBash(tools, "echo same > unrelated.txt");
  assert.deepEqual(writes.pathsOf(directory), ["gen/out.txt", PYC]);
  await runBash(tools, "echo changed > gen/out.txt");
  assert.deepEqual(writes.pathsOf(directory), [PYC]);
  await runBash(tools, `rm ${PYC}`);
  assert.deepEqual(writes.pathsOf(directory), []);
});

test(
  "(invariant guard) a recorded path that a later bash call makes unreadable leaves the record and the call keeps its result",
  {
    skip: process.getuid?.() === ROOT_USER && "root reads a mode 000 file",
  },
  async (t) => {
    const { directory, writes, tools } = await verificationCheckout(
      t,
      "mkdir -p gen && echo out > gen/out.txt",
    );
    await runBash(tools, VERIFY);
    assert.deepEqual(writes.pathsOf(directory), ["gen/out.txt"]);
    await runBash(tools, "chmod 000 gen/out.txt && echo locked");
    assert.deepEqual(writes.pathsOf(directory), []);
  },
);

test(
  "a recorded path that a verification run left unreadable stays recorded after an unrelated bash call",
  {
    skip: process.getuid?.() === ROOT_USER && "root reads a mode 000 file",
  },
  async (t) => {
    const { directory, writes, tools } = await verificationCheckout(
      t,
      "mkdir -p gen && echo out > gen/out.txt && chmod 000 gen/out.txt",
    );
    await runBash(tools, VERIFY);
    assert.deepEqual(writes.pathsOf(directory), ["gen/out.txt"]);
    await runBash(tools, "echo same > unrelated.txt");
    assert.deepEqual(writes.pathsOf(directory), ["gen/out.txt"]);
  },
);

test("a change inside the .git directory of a recorded nested repository keeps the record", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(
    t,
    "git init -q vendor/lib",
  );
  await runBash(tools, VERIFY);
  await runBash(tools, "git -C vendor/lib config core.note changed");
  assert.deepEqual(writes.pathsOf(directory), ["vendor/lib"]);
});

test("a verification run that creates a nested repository records it without a trailing slash", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(
    t,
    "git init -q vendor/lib",
  );
  await runBash(tools, VERIFY);
  assert.deepEqual(writes.pathsOf(directory), ["vendor/lib"]);
});

test("a failing verification run records its new untracked paths and keeps the exit output", async (t) => {
  const { directory, writes, tools } = await verificationCheckout(
    t,
    `${WRITE_PYC}; echo ${FAILING_OUTPUT.trim()}; exit ${FAILING_EXIT}`,
  );
  const result = await runBash(tools, VERIFY);
  const content = result.structuredContent as {
    output: string;
    exit_code: number;
  };
  assert.equal(content.output, FAILING_OUTPUT);
  assert.equal(content.exit_code, FAILING_EXIT);
  assert.deepEqual(writes.pathsOf(directory), [PYC]);
});

test("a verification run deletes no file and changes no tracked file", async (t) => {
  const { directory, git, writes, tools } = await verificationCheckout(
    t,
    WRITE_PYC,
    { "note.txt": NOTE_CONTENT },
  );
  writeFileSync(join(directory, "untracked.txt"), UNTRACKED_CONTENT);
  await runBash(tools, VERIFY);
  assert.equal(
    readFileSync(join(directory, "tracked"), "utf8"),
    TRACKED_CONTENT,
  );
  assert.equal(readFileSync(join(directory, "note.txt"), "utf8"), NOTE_CONTENT);
  assert.equal(
    readFileSync(join(directory, "untracked.txt"), "utf8"),
    UNTRACKED_CONTENT,
  );
  assert.equal(
    (await git.raw(["status", "--porcelain", "--untracked-files=all"])).trim(),
    `?? ${PYC}\n?? untracked.txt`,
  );
  assert.deepEqual(writes.pathsOf(directory), [PYC]);
});
