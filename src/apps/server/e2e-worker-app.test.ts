import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { directories } from "../../config/index.ts";
import { writePrivate } from "../../kernel/files.ts";
import { generateX25519KeyPair } from "../../kernel/hpke.ts";
import { temporary } from "../../kernel/test-support.ts";
import { instanceConfigurationValue } from "../../worker/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import {
  enableCoveringAgents,
  gatewayFixture,
  holdCoveringCredential,
} from "./test-support.ts";

const SPAWN_LINE_TIMEOUT_MS = 15000;
const CLEANUP_WAIT_MS = 5000;
const SIGHUP_WAIT_MS = 200;
const POLL_MS = 50;
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EXIT_SUPERSEDED = 3;
const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1";
const LOOPBACK = "127.0.0.1";
const EPHEMERAL_PORT = 0;
const READY = "Worker instance ready";
const EXIT_TIMEOUT = "Worker exit timed out";
const INITIAL_BUFFER = "";
const NO_OUTPUT = "";
const NEWLINE = "\n";
const NEWLINE_LEN = 1;
const SINGLE_RECORD = 1;
const NO_REGISTRATIONS = 0;
const WORKER_ARGS = ["serve", "worker"];
const INSTANCE_CONFIG_VARIABLE = "KANTHORD_WORKER_CONFIG";
const INSTANCE_NAME = "laptop";
const INSTANCE_WORKER = "coder@1";
const ROTATED_REVISIONS = 2;
const INSTANCE_BINDING = "laptop-coder";
const PROJECT_NAMES = ["instance-a", "instance-b"];
const FIXTURE_INSTANCE_ID = "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const BASE64URL = "base64url";
const FILE_SOURCE = "file";

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
  let stdout = INITIAL_BUFFER;
  let partial = INITIAL_BUFFER;
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
    while (index !== -NEWLINE_LEN) {
      addLine(partial.slice(0, index));
      partial = partial.slice(index + NEWLINE_LEN);
      index = partial.indexOf(NEWLINE);
    }
  });
  child.stderr.once("end", () => {
    if (partial) addLine(partial);
    partial = INITIAL_BUFFER;
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
  const result = await within(proc.exited, SPAWN_LINE_TIMEOUT_MS);
  assert.equal(result.code, EXIT_FAILURE);
  assert.ok(
    result.stderr.join(NEWLINE).startsWith(`${code}:`),
    result.stderr.join(NEWLINE),
  );
}

async function instanceValue(endpoint: string): Promise<string> {
  const pair = await generateX25519KeyPair();
  return instanceConfigurationValue({
    name: INSTANCE_NAME,
    endpoint,
    instance_id: FIXTURE_INSTANCE_ID,
    private_key: pair.private_key.toString(BASE64URL),
  });
}

async function liveInstance(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const env = workerEnvironment(t);
  env.KANTHORD_ENDPOINT = undefined;
  const human = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  await enableCoveringAgents(human);
  const run = async <T>(
    args: string[],
    runEnv: NodeJS.ProcessEnv = human,
  ): Promise<T> => {
    const result = await kanthord(args, runEnv);
    assert.equal(result.code, EXIT_SUCCESS, result.stderr);
    return JSON.parse(result.stdout) as T;
  };
  const created = await run<{ id: string; created: string }>(
    [
      "worker",
      "instance",
      "create",
      INSTANCE_NAME,
      "--worker",
      INSTANCE_WORKER,
      "--output",
    ],
    { ...human, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
  );
  await holdCoveringCredential(human, INSTANCE_NAME);
  const projects: string[] = [];
  for (const name of PROJECT_NAMES) {
    const project = await run<{ id: string }>([
      "project",
      "create",
      "--name",
      name,
    ]);
    const path = join(temporary(t), "bindings.json");
    writePrivate(
      path,
      JSON.stringify({
        version: 1,
        bindings: {
          [INSTANCE_BINDING]: {
            kind: "worker",
            config: {
              worker: INSTANCE_WORKER,
              placement: "worker",
              worker_instances: [INSTANCE_NAME],
              tags: [],
            },
          },
        },
      }),
    );
    await run(["project", "binding", "apply", project.id, "--file", path]);
    const paused = await run<{ paused_at: number | null }>([
      "project",
      "pause",
      project.id,
    ]);
    assert.notEqual(paused.paused_at, null);
    projects.push(project.id);
  }
  const registered = async (projectId: string) =>
    (
      await run<{ items: { registered: boolean }[] }>([
        "worker",
        "registration",
        "list",
        "--project",
        projectId,
      ])
    ).items.filter((item) => item.registered).length;
  return { fixture, env, human, created, projects, registered };
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + SPAWN_LINE_TIMEOUT_MS;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Timed out waiting for the condition");
    await delay(POLL_MS);
  }
}

test("E09.1 worker refuses --config and --token", async (t) => {
  const env = workerEnvironment(t);
  const config = await kanthord(
    [...WORKER_ARGS, "--config", join(env.XDG_CONFIG_HOME!, "config.yaml")],
    env,
  );
  assert.equal(config.code, EXIT_FAILURE);
  assert.ok(config.stderr.startsWith("cli.serve.worker_config:"));
  const token = await kanthord([...WORKER_ARGS, "--token", "x"], env);
  assert.equal(token.code, EXIT_FAILURE);
  assert.ok(token.stderr.startsWith("cli.serve.worker_token:"));
});

test("E09.2 an absent instance configuration refuses before network", async (t) => {
  const env = workerEnvironment(t);
  const proc = spawnWorker([...WORKER_ARGS, "--instance", INSTANCE_NAME], env);
  try {
    await failure(proc, "worker.start.instance_config_absent");
  } finally {
    await stopWorker(proc);
  }
});

test("E09.3 an invalid instance configuration refuses before network", async (t) => {
  const env = workerEnvironment(t);
  env[INSTANCE_CONFIG_VARIABLE] =
    `${await instanceValue(UNREACHABLE_ENDPOINT)}=`;
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    await failure(proc, "worker.instance.config_invalid");
  } finally {
    await stopWorker(proc);
  }
});

test("E09.4 tools that cannot be installed refuse before any network request", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.end();
  });
  await new Promise<void>((resolve) =>
    server.listen(EPHEMERAL_PORT, LOOPBACK, resolve),
  );
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && address instanceof Object);
  const env = workerEnvironment(t);
  env.KANTHORD_ENDPOINT = undefined;
  const binDirectory = join(
    directories(env).data,
    "workers",
    INSTANCE_NAME,
    "pi",
    "bin",
  );
  mkdirSync(dirname(binDirectory), { recursive: true });
  writeFileSync(binDirectory, "");
  env[INSTANCE_CONFIG_VARIABLE] = await instanceValue(
    `http://${LOOPBACK}:${address.port}`,
  );
  const proc = spawnWorker(WORKER_ARGS, env);
  try {
    await failure(proc, "worker.start.tool_missing");
    assert.equal(requests, EXIT_SUCCESS);
  } finally {
    await stopWorker(proc);
  }
});

test(
  "a live instance on 127.0.0.1 registers two bindings of two paused projects and a second process supersedes it",
  { timeout: 180000 },
  async (t) => {
    const live = await liveInstance(t);
    const args = [...WORKER_ARGS, "--instance", INSTANCE_NAME];
    const first = spawnWorker(args, live.env);
    try {
      const line = await first
        .waitForLine((entry) => entry.includes(READY))
        .catch(async (error) => {
          throw new Error((await first.exited).stderr.join(NEWLINE), {
            cause: error,
          });
        });
      const record = JSON.parse(line);
      assert.equal(record.instance, INSTANCE_NAME);
      assert.equal(record.config_source, FILE_SOURCE);
      await eventually(async () => {
        const counts = await Promise.all(live.projects.map(live.registered));
        return counts.every((count) => count === SINGLE_RECORD);
      });
      first.kill("SIGHUP");
      await delay(SIGHUP_WAIT_MS);
      assert.ok(first.alive());
      const second = spawnWorker(args, live.env);
      try {
        await second.waitForLine((entry) => entry.includes(READY));
        const superseded = await within(first.exited, SPAWN_LINE_TIMEOUT_MS);
        assert.equal(superseded.code, EXIT_SUPERSEDED);
        assert.equal(superseded.stdout, NO_OUTPUT);
        const stderr = superseded.stderr.join(NEWLINE);
        assert.ok(stderr.includes("worker.instance.superseded"), stderr);
        for (const projectId of live.projects)
          assert.equal(await live.registered(projectId), SINGLE_RECORD);
        second.kill("SIGTERM");
        const stopped = await within(second.exited, CLEANUP_WAIT_MS);
        assert.equal(stopped.code, EXIT_SUCCESS);
        assert.equal(stopped.signal, null);
        for (const entry of stopped.stderr.filter(Boolean)) JSON.parse(entry);
        for (const projectId of live.projects)
          assert.equal(await live.registered(projectId), NO_REGISTRATIONS);
      } finally {
        await stopWorker(second);
      }
    } finally {
      await stopWorker(first);
    }
  },
);

test("llm credential create and rotate with --holder seal locally with the instance file, and without the file send the secret to the server", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = workerEnvironment(t);
  const human = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const run = async (args: string[], runEnv: NodeJS.ProcessEnv = human) => {
    const result = await kanthord(args, runEnv);
    assert.equal(result.code, EXIT_SUCCESS, result.stderr);
    return JSON.parse(result.stdout);
  };
  await run(
    [
      "worker",
      "instance",
      "create",
      INSTANCE_NAME,
      "--worker",
      INSTANCE_WORKER,
      "--output",
    ],
    { ...human, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME },
  );
  const local = {
    ...env,
    KANTHORD_ENDPOINT: undefined,
    KANTHORD_TOKEN: undefined,
  };
  const file = join(temporary(t), "credential.json");
  writePrivate(
    file,
    JSON.stringify({
      name: "local-llm",
      platform: "anthropic",
      metadata: null,
      secret: { key: "local-provider-key" },
    }),
  );
  const invalid = join(temporary(t), "invalid.json");
  writePrivate(
    invalid,
    JSON.stringify({
      name: "invalid-llm",
      platform: "anthropic",
      metadata: null,
      secret: { token: "not-an-api-key" },
    }),
  );
  const refused = await kanthord(
    [
      "llm",
      "credential",
      "create",
      "--file",
      invalid,
      "--holder",
      INSTANCE_NAME,
    ],
    local,
  );
  assert.notEqual(refused.code, EXIT_SUCCESS);
  assert.ok(refused.stderr.includes("cli.llm.credential.secret_invalid"));
  const created = await run(
    ["llm", "credential", "create", "--file", file, "--holder", INSTANCE_NAME],
    local,
  );
  assert.equal(created.holder, INSTANCE_NAME);
  assert.equal(created.sealed_current, true);
  const rotation = join(temporary(t), "rotation.json");
  writePrivate(
    rotation,
    JSON.stringify({ expected_revision: 1, secret: { key: "rotated-key" } }),
  );
  const rotated = await run(
    [
      "llm",
      "credential",
      "rotate",
      "local-llm",
      "--file",
      rotation,
      "--holder",
      INSTANCE_NAME,
    ],
    local,
  );
  assert.equal(rotated.revisions.length, ROTATED_REVISIONS);
  const viaServer = join(temporary(t), "server.json");
  writePrivate(
    viaServer,
    JSON.stringify({
      name: "server-sealed",
      platform: "anthropic",
      metadata: null,
      secret: { key: "server-sealed-key" },
    }),
  );
  const sealedByServer = await run([
    "llm",
    "credential",
    "create",
    "--file",
    viaServer,
    "--holder",
    INSTANCE_NAME,
  ]);
  assert.equal(sealedByServer.holder, INSTANCE_NAME);
  const listed = await run([
    "llm",
    "credential",
    "list",
    "--holder",
    INSTANCE_NAME,
  ]);
  assert.deepEqual(
    listed.items.map((item: { name: string }) => item.name),
    ["local-llm", "server-sealed"],
  );
  const got = await run([
    "llm",
    "credential",
    "get",
    "local-llm",
    "--holder",
    INSTANCE_NAME,
  ]);
  assert.equal(got.revisions.length, ROTATED_REVISIONS);
  assert.equal(JSON.stringify(got).includes("rotated-key"), false);
});
