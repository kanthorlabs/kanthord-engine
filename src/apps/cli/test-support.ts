import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { isNumber, isString, ValueType } from "../../kernel/values.ts";
import { CommandName, ExitCode, PROGRAM_NAME } from "./constants.ts";
import { runCLI } from "./index.ts";

const EMPTY_ARGUMENT_COUNT = 0;
const COMMAND_TIMEOUT_MS = 10000;
const EMPTY_OUTPUT = "";
const PRIVATE_UMASK = 0o077;
const DEFAULT_ENCODING = "utf8";
const NO_ACTIVE_RUNS = 0;
const TERMINAL_PROPERTY = "isTTY";

export type CliResult = { code: number; stdout: string; stderr: string };

type CliCapture = {
  env: NodeJS.ProcessEnv;
  terminal: boolean;
  stdout: string[];
  stderr: string[];
};

type WriteCallback = (error?: Error | null) => void;

const cliCapture = new AsyncLocalStorage<CliCapture>();
let activeRuns = NO_ACTIVE_RUNS;
let restoreProcess = () => {};

function definedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, String(value)]],
    ),
  );
}

function routedEnvironment(host: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const target = () => cliCapture.getStore()?.env ?? host;
  return new Proxy<NodeJS.ProcessEnv>(
    {},
    {
      get: (_, name) => Reflect.get(target(), name),
      set: (_, name, value) => Reflect.set(target(), name, String(value)),
      has: (_, name) => Reflect.has(target(), name),
      deleteProperty: (_, name) => Reflect.deleteProperty(target(), name),
      ownKeys: () => Reflect.ownKeys(target()),
      getOwnPropertyDescriptor: (_, name) => {
        const descriptor = Reflect.getOwnPropertyDescriptor(target(), name);
        return descriptor && { ...descriptor, configurable: true };
      },
      defineProperty: (_, name, descriptor) =>
        Reflect.defineProperty(target(), name, descriptor),
    },
  );
}

function capturedWrite(
  stream: NodeJS.WriteStream,
  select: (capture: CliCapture) => string[],
): () => void {
  const write = stream.write;
  stream.write = function (
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean {
    const capture = cliCapture.getStore();
    if (!capture)
      return Reflect.apply(write, stream, [chunk, encoding, callback]);
    select(capture).push(
      isString(chunk)
        ? chunk
        : Buffer.from(chunk).toString(
            isString(encoding) ? encoding : DEFAULT_ENCODING,
          ),
    );
    (typeof encoding === ValueType.Function
      ? (encoding as WriteCallback)
      : callback)?.();
    return true;
  } as NodeJS.WriteStream["write"];
  return () => {
    stream.write = write;
  };
}

function routedTerminal(stream: NodeJS.WriteStream): () => void {
  const own = Object.getOwnPropertyDescriptor(stream, TERMINAL_PROPERTY);
  const isTTY = stream.isTTY;
  Object.defineProperty(stream, TERMINAL_PROPERTY, {
    configurable: true,
    get: () => {
      const capture = cliCapture.getStore();
      return capture ? capture.terminal || undefined : isTTY;
    },
  });
  return () => {
    if (own) Object.defineProperty(stream, TERMINAL_PROPERTY, own);
    else Reflect.deleteProperty(stream, TERMINAL_PROPERTY);
  };
}

function routedProcess(): () => void {
  const host = process.env;
  const exitCode = process.exitCode;
  const umask = process.umask(PRIVATE_UMASK);
  const restoreTerminal = routedTerminal(process.stdout);
  const restoreStdout = capturedWrite(process.stdout, (c) => c.stdout);
  const restoreStderr = capturedWrite(process.stderr, (c) => c.stderr);
  process.env = routedEnvironment(host);
  return () => {
    process.env = host;
    restoreStderr();
    restoreStdout();
    restoreTerminal();
    process.umask(umask);
    process.exitCode = exitCode;
  };
}

export async function runInProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  terminal = false,
): Promise<CliResult> {
  assert.ok(env.XDG_CONFIG_HOME);
  const capture: CliCapture = {
    env: definedEnvironment(env),
    terminal,
    stdout: [],
    stderr: [],
  };
  if (activeRuns++ === NO_ACTIVE_RUNS) restoreProcess = routedProcess();
  try {
    const code = await cliCapture.run(capture, () =>
      runCLI([process.execPath, PROGRAM_NAME, ...args]),
    );
    return {
      code,
      stdout: capture.stdout.join(EMPTY_OUTPUT),
      stderr: capture.stderr.join(EMPTY_OUTPUT),
    };
  } finally {
    if (--activeRuns === NO_ACTIVE_RUNS) restoreProcess();
  }
}

export function spawnKanthord(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CliResult> {
  assert.ok(args.length > EMPTY_ARGUMENT_COUNT);
  assert.ok(env.XDG_CONFIG_HOME);
  const entry = new URL("../../main.ts", import.meta.url).href;
  return new Promise<CliResult>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
      ],
      { env, timeout: COMMAND_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const code = error?.code;
        if (error && !isNumber(code)) return reject(error);
        resolve({
          code: isNumber(code) ? code : ExitCode.Success,
          stdout,
          stderr,
        });
      },
    );
  });
}

export function runKanthord(
  args: string[],
  env: NodeJS.ProcessEnv,
  terminal = false,
): Promise<CliResult> {
  return args[0] === CommandName.Serve
    ? spawnKanthord(args, env)
    : runInProcess(args, env, terminal);
}
