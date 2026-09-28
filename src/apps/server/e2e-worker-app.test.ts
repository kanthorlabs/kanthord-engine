import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { directories } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import { packageVersion } from "../../kernel/version.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_WORKER_BINDING,
} from "./test-support.ts";

const SPAWN_LINE_TIMEOUT_MS = 15000;
const CLEANUP_WAIT_MS = 5000;
const SIGHUP_WAIT_MS = 200;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const KEY_BYTES = 32;
const INVALID_KEY_BYTES = 16;
const FAKE_VERSION = "0.0.0";
const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1";
const LOOPBACK = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const NOT_FOUND_STATUS = 404;
const OPENAPI_PATH = "/api/openapi.yaml";
const GET = "GET";
const STARTED = "Worker application started";
const READY = "Worker application ready";
const EXIT_TIMEOUT = "Worker exit timed out";
const EMPTY = "";
const NEWLINE = "\n";
const ONE = 1;
const WORKER_ARGS = ["serve", "worker"];

type Exit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string[];
};

type WorkerProcess = {
  waitForLine(predicate: (line: string) => boolean): Promise<string>;
  kill(signal: NodeJS.Signals): void;
  exited: Promise<Exit>;
  alive(): boolean;
  failed(): boolean;
};

function workerEnvironment(t: TestContext): NodeJS.ProcessEnv {
  const root = temporary(t);
  const env = {
    ...environment(root),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    KANTHORD_ENDPOINT: UNREACHABLE_ENDPOINT,
  };
  assert.notEqual(env.XDG_CONFIG_HOME, env.XDG_DATA_HOME);
  assert.notEqual(env.XDG_DATA_HOME, env.XDG_STATE_HOME);
  return env;
}

function clientFile(env: NodeJS.ProcessEnv, masterKey: string): void {
  assert.ok(env.XDG_CONFIG_HOME);
  assert.ok(masterKey);
  writePrivate(
    join(directories(env).config, "cli.yaml"),
    stringify({ masterKey }),
  );
}

function spawnWorker(args: string[], env: NodeJS.ProcessEnv): WorkerProcess {
  assert.ok(args.length);
  assert.ok(env.XDG_CONFIG_HOME);
  const entry = new URL("../../main.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { env, stdio: "pipe" },
  );
  let stdout = EMPTY;
  let partial = EMPTY;
  let spawnError: Error | undefined;
  let exitSeen = false;
  let settled = false;
  const lines: string[] = [];
  const waiting = new Set<{
    predicate: (line: string) => boolean;
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }>();
  const rejectWaiting = (error: Error) => {
    for (const waiter of waiting) waiter.reject(error);
    waiting.clear();
  };
  const addLine = (line: string) => {
    lines.push(line);
    for (const waiter of waiting) {
      if (!waiter.predicate(line)) continue;
      waiting.delete(waiter);
      waiter.resolve(line);
    }
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    partial += chunk;
    let index = partial.indexOf(NEWLINE);
    while (index !== -ONE) {
      addLine(partial.slice(0, index));
      partial = partial.slice(index + ONE);
      index = partial.indexOf(NEWLINE);
    }
  });
  child.stderr.once("end", () => {
    if (partial) addLine(partial);
    partial = EMPTY;
  });
  child.once("exit", () => {
    exitSeen = true;
    rejectWaiting(new Error("Worker exited before the expected line"));
  });
  const exited = new Promise<Exit>((resolve, reject) => {
    child.once("error", (error) => {
      spawnError = error;
      settled = true;
      rejectWaiting(error);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (spawnError) return;
      settled = true;
      resolve({ code, signal, stdout, stderr: lines });
    });
  });
  return {
    exited,
    failed: () => spawnError !== undefined,
    alive: () =>
      child.exitCode === null && child.signalCode === null && !exitSeen,
    kill: (signal) => {
      if (!settled && !spawnError) child.kill(signal);
    },
    waitForLine: (predicate) => {
      try {
        const found = lines.find(predicate);
        if (found !== undefined) return Promise.resolve(found);
        if (spawnError || exitSeen || settled)
          return Promise.reject(
            spawnError ?? new Error("Worker already exited"),
          );
      } catch (error) {
        return Promise.reject(error);
      }
      return new Promise<string>((resolve, reject) => {
        const waiter = {
          predicate,
          resolve: (line: string) => {
            clearTimeout(timer);
            waiting.delete(waiter);
            resolve(line);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            waiting.delete(waiter);
            reject(error);
          },
        };
        waiting.add(waiter);
        const timer = setTimeout(() => {
          waiter.reject(new Error("Timed out waiting for worker stderr line"));
        }, SPAWN_LINE_TIMEOUT_MS);
      });
    },
  };
}

async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  assert.ok(milliseconds > EXIT_SUCCESS);
  assert.ok(promise);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(EXIT_TIMEOUT)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopWorker(proc: WorkerProcess): Promise<void> {
  if (proc.failed()) return;
  proc.kill("SIGTERM");
  try {
    await within(proc.exited, CLEANUP_WAIT_MS);
    return;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== EXIT_TIMEOUT)
      throw error;
  }
  proc.kill("SIGKILL");
  await within(proc.exited, CLEANUP_WAIT_MS);
}

async function failure(proc: WorkerProcess, code: string): Promise<void> {
  const result = await within(proc.exited, CLEANUP_WAIT_MS);
  assert.equal(result.code, EXIT_FAILURE);
  assert.ok(
    result.stderr.join(NEWLINE).startsWith(`${code}:`),
    result.stderr.join(NEWLINE),
  );
}

async function fakeEndpoint(t: TestContext): Promise<string> {
  const server = createServer((request, response) => {
    if (request.method !== GET || request.url !== OPENAPI_PATH) {
      response.writeHead(NOT_FOUND_STATUS).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ info: { version: FAKE_VERSION } }));
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(EPHEMERAL_PORT, LOOPBACK, resolve);
  });
  const address = server.address();
  if (!address || !(address instanceof Object))
    throw new Error("Fake server has no TCP address");
  assert.ok(address.port > EPHEMERAL_PORT);
  return `http://${LOOPBACK}:${address.port}`;
}

async function liveEnvironment(
  t: TestContext,
): Promise<{ env: NodeJS.ProcessEnv; token: string }> {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const token = await fixture.machineToken(TEST_WORKER_BINDING);
  const env = {
    ...workerEnvironment(t),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: token,
  };
  clientFile(env, randomBytes(KEY_BYTES).toString("base64"));
  assert.ok(token);
  assert.ok(env.KANTHORD_ENDPOINT);
  return { env, token };
}

test("E09.1 worker refuses --config", async (t) => {
  const env = workerEnvironment(t);
  const result = await kanthord(
    [...WORKER_ARGS, "--config", join(env.XDG_CONFIG_HOME!, "config.yaml")],
    env,
  );
  assert.equal(result.code, EXIT_FAILURE);
  assert.ok(result.stderr.startsWith("cli.serve.worker_config:"));
});

test("E09.2 absent masterKey refuses before network", async (t) => {
  const env = workerEnvironment(t);
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    await failure(proc, "worker.start.master_key_absent");
  } finally {
    await stopWorker(proc);
  }
});

test("E09.3 invalid masterKey refuses before network", async (t) => {
  const env = workerEnvironment(t);
  clientFile(env, randomBytes(INVALID_KEY_BYTES).toString("base64"));
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    await failure(proc, "worker.start.master_key_invalid");
  } finally {
    await stopWorker(proc);
  }
});

test("E09.4 version mismatch reports both versions", async (t) => {
  const env = workerEnvironment(t);
  env.KANTHORD_ENDPOINT = await fakeEndpoint(t);
  clientFile(env, randomBytes(KEY_BYTES).toString("base64"));
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    const result = await within(proc.exited, CLEANUP_WAIT_MS);
    assert.equal(result.code, EXIT_FAILURE);
    const stderr = result.stderr.join(NEWLINE);
    assert.ok(stderr.startsWith("worker.version.mismatch:"), stderr);
    assert.ok(stderr.includes(packageVersion()));
    assert.ok(stderr.includes(FAKE_VERSION));
  } finally {
    await stopWorker(proc);
  }
});

test("E09.5 startup is one JSON record and SIGTERM exits cleanly", async (t) => {
  const { env, token } = await liveEnvironment(t);
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    const line = await proc.waitForLine((entry) => entry.includes(STARTED));
    assert.equal(JSON.parse(line).msg, STARTED);
    proc.kill("SIGTERM");
    const result = await within(proc.exited, CLEANUP_WAIT_MS);
    const records = result.stderr
      .filter(Boolean)
      .map((entry) => JSON.parse(entry));
    assert.equal(
      records.filter((record) => record.msg === STARTED).length,
      ONE,
    );
    assert.ok(records.every((record) => record.msg !== READY));
    assert.equal(result.stdout, EMPTY);
    assert.ok(result.stderr.every((entry) => !entry.includes(token)));
    assert.equal(result.signal, null);
    assert.equal(result.code, EXIT_SUCCESS);
  } finally {
    await stopWorker(proc);
  }
});

test("E09.6 SIGHUP leaves the worker alive until SIGTERM", async (t) => {
  const { env } = await liveEnvironment(t);
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    const line = await proc.waitForLine((entry) => entry.includes(STARTED));
    assert.equal(JSON.parse(line).msg, STARTED);
    proc.kill("SIGHUP");
    await delay(SIGHUP_WAIT_MS);
    assert.ok(proc.alive());
    proc.kill("SIGTERM");
    const result = await within(proc.exited, CLEANUP_WAIT_MS);
    assert.equal(result.signal, null);
    assert.equal(result.code, EXIT_SUCCESS);
  } finally {
    await stopWorker(proc);
  }
});
