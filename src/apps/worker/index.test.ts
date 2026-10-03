import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stringify } from "yaml";
import { CancellationContext } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { packageVersion } from "../../kernel/version.ts";
import { temporary } from "../../kernel/test-support.ts";
import { isObject, isString } from "../../kernel/values.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { writePrivate } from "../../kernel/files.ts";
import { clientConfigPath, resolveClient } from "../../gateway/client.ts";
import { Worker, runWorker } from "./index.ts";

const STARTED_MESSAGE = "Worker application ready";
const REGISTRATION = {
  runtimeIdentity: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  resourceIdentity: "worker:kanthord:test",
  workerName: "general@1",
};
const MISMATCH_VERSION = "0.0.0-mismatch";
const MISMATCH_CODE = "worker.version.mismatch";
const UNAVAILABLE_CODE = "worker.version.unavailable";
const OPENAPI_PATH = "/api/openapi.yaml";
const REGISTER_PATH = "/api/worker/register";
const DEREGISTER_PATH = `/api/worker/instance/${REGISTRATION.runtimeIdentity}`;
const AUTHORIZATION = "Bearer test-token";
const CLIENT_SECRET_BYTES = 32;
const SHORT_KEY_BYTES = 16;
const ABSENT_CODE = "worker.start.client_secret_absent";
const INVALID_CODE = "worker.start.client_secret_invalid";
const INVALID_CONFIG_CODE = "cli.config.invalid";
const NON_BASE64_KEY = "not a base64 key!";
const ENV_CLIENT_SECRET = "environment-secret";
const OPTION_CLIENT_SECRET = "option-secret";
const NO_REQUESTS = 0;
const CHILD_START_TIMEOUT_MS = 5000;
const CHILD_EXIT_TIMEOUT_MS = 5000;
const WORKER_STOP_WATCHDOG_MS = 10000;
const AFTER_WATCHDOG_MS = WORKER_STOP_WATCHDOG_MS + 1;
const WORKER_STOP_EXIT_FAILURE = 1;
const EXIT_SUCCESS = 0;
const ONE_RECORD = 1;
const SHORT_WAIT_MS = 20;
const RUNNING_STATE = "running";
const CHILD_SCRIPT = `
  import { runWorker } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
  const error = await runWorker(JSON.parse(process.env.WORKER_OPTIONS));
  if (error) { process.stderr.write(error.message); process.exitCode = 1; }
`;

async function bounded<T>(promise: Promise<T>, duration: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out waiting for worker")),
          duration,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(
  t: TestContext,
  version: string,
  intercept?: (request: IncomingMessage, response: ServerResponse) => boolean,
) {
  const tools = temporary(t);
  for (const name of ["rg", "fd"])
    writeFileSync(join(tools, name), "#!/bin/sh\necho test_tool\n", {
      mode: 0o700,
    });
  const previousPath = process.env.PATH;
  process.env.PATH = `${tools}:${previousPath ?? ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  let requests = 0;
  const listener = createServer((request, response) => {
    assert.equal(request.headers.authorization, AUTHORIZATION);
    requests++;
    if (intercept?.(request, response)) return;
    if (request.url === DEREGISTER_PATH) {
      response.writeHead(HttpStatus.OK, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          runtimeIdentity: REGISTRATION.runtimeIdentity,
          registered: false,
        }),
      );
      return;
    }
    if (request.url === REGISTER_PATH) {
      response.writeHead(HttpStatus.OK, { "Content-Type": "application/json" });
      response.end(JSON.stringify(REGISTRATION));
      return;
    }
    assert.equal(request.url, OPENAPI_PATH);
    response.writeHead(HttpStatus.OK, { "Content-Type": "application/yaml" });
    response.end(stringify({ info: { version } }));
  });
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  const directory = temporary(t);
  const env = { XDG_CONFIG_HOME: directory, XDG_STATE_HOME: temporary(t) };
  writePrivate(
    clientConfigPath(env),
    stringify({
      clientSecret: randomBytes(CLIENT_SECRET_BYTES).toString("base64"),
    }),
  );
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    token: "test-token",
    env,
    directory,
    requests: () => requests,
  };
}

test("worker healthcheck is unavailable before start", async () => {
  const worker = new Worker();
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Unavailable,
  });
  assert.equal(await worker.stop(), null);
});

test("worker healthcheck becomes unavailable on quiesce before stop", async (t) => {
  const options = await fixture(t, packageVersion());
  const worker = new Worker({ ...options, log: () => {} });
  try {
    assert.equal(await worker.start(), null);
    assert.deepEqual(await worker.healthcheck(), {
      client: HealthStatus.Healthy,
    });
    assert.equal(await worker.quiesce(), null);
    assert.deepEqual(await worker.healthcheck(), {
      client: HealthStatus.Unavailable,
    });
  } finally {
    assert.equal(await worker.stop(), null);
  }
});

test("matching worker starts once and joins context cancellation without server configuration or database", async (t) => {
  const options = await fixture(t, packageVersion());
  const filesBefore = readdirSync(options.directory, { recursive: true });
  const messages: string[] = [];
  const worker = new Worker({
    ...options,
    log: (message) => {
      messages.push(message);
    },
  });
  const context = new CancellationContext();
  const signals = process.listenerCount("SIGTERM");
  const running = worker.run(context);
  assert.equal(worker.start(), worker.start());
  assert.equal(await worker.start(), null);
  assert.deepEqual(await worker.healthcheck(), { client: HttpStatus.OK });
  assert.deepEqual(
    messages.map((message) => JSON.parse(message)),
    [{ msg: STARTED_MESSAGE, ...REGISTRATION }],
  );
  const SINGLE_REQUEST = 2;
  assert.equal(options.requests(), SINGLE_REQUEST);
  context.cancel();
  assert.equal(await running, context.err());
  assert.equal(worker.quiesce(), worker.quiesce());
  assert.equal(worker.stop(), worker.stop());
  assert.equal(await worker.stop(), null);
  assert.deepEqual(await worker.healthcheck(), {
    client: HttpStatus.ServiceUnavailable,
  });
  assert.equal(process.listenerCount("SIGTERM"), signals);
  assert.deepEqual(
    readdirSync(options.directory, { recursive: true }),
    filesBefore,
  );
  assert.ok((await worker.start()) instanceof Error);
});

test("version mismatch names both versions, starts nothing and releases signal listeners", async (t) => {
  const options = await fixture(t, MISMATCH_VERSION);
  const filesBefore = readdirSync(options.directory, { recursive: true });
  const messages: string[] = [];
  const signals = process.listenerCount("SIGTERM");
  const error = await runWorker({
    ...options,
    log: (message) => {
      messages.push(message);
    },
  });
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISMATCH_CODE);
  assert.ok(error.message.includes(packageVersion()));
  assert.ok(error.message.includes(MISMATCH_VERSION));
  assert.deepEqual(messages, []);
  assert.deepEqual(
    readdirSync(options.directory, { recursive: true }),
    filesBefore,
  );
  assert.equal(process.listenerCount("SIGTERM"), signals);
});

test("worker healthcheck stays unavailable after version mismatch", async (t) => {
  const options = await fixture(t, MISMATCH_VERSION);
  const worker = new Worker({ ...options, log: () => {} });
  const error = await worker.start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISMATCH_CODE);
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Unavailable,
  });
});

test("worker healthcheck stays unavailable after absent clientSecret", async (t) => {
  const options = await fixture(t, packageVersion());
  unlinkSync(clientConfigPath(options.env));
  const worker = new Worker({ ...options, log: () => {} });
  const error = await worker.start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, ABSENT_CODE);
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Unavailable,
  });
});

test("worker refuses an absent clientSecret before contacting the server", async (t) => {
  const options = await fixture(t, packageVersion());
  unlinkSync(clientConfigPath(options.env));
  const messages: string[] = [];
  const error = await new Worker({
    ...options,
    log: (message) => messages.push(message),
  }).start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, ABSENT_CODE);
  assert.deepEqual(messages, []);
  assert.equal(options.requests(), NO_REQUESTS);
});

test("worker refuses invalid and non-canonical clientSecrets before contacting the server", async (t) => {
  const options = await fixture(t, packageVersion());
  const invalidKeys = [
    randomBytes(SHORT_KEY_BYTES).toString("base64"),
    NON_BASE64_KEY,
    `${randomBytes(CLIENT_SECRET_BYTES).toString("base64")}=`,
  ];
  for (const clientSecret of invalidKeys) {
    writePrivate(
      clientConfigPath(options.env),
      stringify({ clientSecret }),
      true,
    );
    const messages: string[] = [];
    const error = await new Worker({
      ...options,
      log: (message) => messages.push(message),
    }).start();
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, INVALID_CODE);
    assert.deepEqual(messages, []);
    assert.equal(options.requests(), NO_REQUESTS);
  }
});

test("client reads clientSecret only from cli.yaml while accepting service configuration", async (t) => {
  const options = await fixture(t, packageVersion());
  const clientSecret = randomBytes(CLIENT_SECRET_BYTES).toString("base64");
  writePrivate(
    clientConfigPath(options.env),
    stringify({ clientSecret }),
    true,
  );
  const env = { ...options.env, KANTHORD_CLIENT_SECRET: ENV_CLIENT_SECRET };
  assert.equal(resolveClient({}, env).clientSecret, clientSecret);
  assert.equal(
    resolveClient({ clientSecret: OPTION_CLIENT_SECRET }, env).clientSecret,
    clientSecret,
  );
  unlinkSync(clientConfigPath(options.env));
  assert.equal(
    resolveClient({ clientSecret: OPTION_CLIENT_SECRET }, env).clientSecret,
    undefined,
  );
});

test("client rejects a masterKey field without disclosing its value", async (t) => {
  const options = await fixture(t, packageVersion());
  const masterKey = randomBytes(CLIENT_SECRET_BYTES).toString("base64");
  writePrivate(clientConfigPath(options.env), stringify({ masterKey }), true);
  assert.throws(
    () => resolveClient({}, options.env),
    (error: unknown) => {
      assert.ok(error instanceof Diagnostic);
      assert.equal(error.code, INVALID_CONFIG_CODE);
      assert.ok(!error.message.includes(masterKey));
      return true;
    },
  );
});

test("default worker log is one JSON line on stderr without the token", async (t) => {
  const options = await fixture(t, packageVersion());
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", CHILD_SCRIPT],
    {
      env: { ...process.env, WORKER_OPTIONS: JSON.stringify(options) },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.includes(`${STARTED_MESSAGE}"`)) started.resolve();
  });
  child.on("error", (error) => {
    started.reject(error);
    exited.reject(error);
  });
  child.on("exit", (code, signal) => {
    started.reject(new Error("Worker exited before startup"));
    exited.resolve({ code, signal });
  });
  try {
    await bounded(started.promise, CHILD_START_TIMEOUT_MS);
    child.kill("SIGTERM");
    assert.deepEqual(await bounded(exited.promise, CHILD_EXIT_TIMEOUT_MS), {
      code: EXIT_SUCCESS,
      signal: null,
    });
    const lines = stderr.split("\n").filter(Boolean);
    const records: unknown[] = lines.map((line) => JSON.parse(line));
    assert.equal(
      records.filter(
        (record) =>
          isObject(record) && "msg" in record && record.msg === STARTED_MESSAGE,
      ).length,
      ONE_RECORD,
    );
    assert.equal(lines.length, ONE_RECORD);
    assert.ok(!stderr.includes(options.token));
  } finally {
    child.kill("SIGKILL");
    await bounded(exited.promise, CHILD_EXIT_TIMEOUT_MS);
  }
});

test("SIGHUP leaves worker healthy and unregisters its handler on termination", async (t) => {
  const options = await fixture(t, packageVersion());
  const started = Promise.withResolvers<void>();
  const before = process.listenerCount("SIGHUP");
  const worker = new Worker({ ...options, log: () => started.resolve() });
  const running = worker.run();
  try {
    await bounded(started.promise, CHILD_START_TIMEOUT_MS);
    process.emit("SIGHUP");
    const outcome = await Promise.race([
      running.then(() => "settled"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve(RUNNING_STATE), SHORT_WAIT_MS),
      ),
    ]);
    assert.equal(outcome, RUNNING_STATE);
    assert.deepEqual(await worker.healthcheck(), { client: HttpStatus.OK });
  } finally {
    process.emit("SIGTERM");
    assert.equal(await bounded(running, CHILD_EXIT_TIMEOUT_MS), null);
  }
  assert.equal(process.listenerCount("SIGHUP"), before);
});

test("stop watchdog starts only after unresolved startup settles", async (t) => {
  const exits: unknown[] = [];
  const stalled = new Worker();
  t.mock.method(stalled, "quiesce", () => new Promise<null>(() => {}));
  t.mock.method(process, "exit", (code?: number | string | null) => {
    exits.push(code);
    return undefined as never;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    void stalled.stop();
    t.mock.timers.tick(WORKER_STOP_WATCHDOG_MS);
    assert.deepEqual(exits, []);
    const finished = new Worker();
    assert.equal(await finished.stop(), null);
    t.mock.timers.tick(AFTER_WATCHDOG_MS);
    assert.deepEqual(exits, []);
  } finally {
    t.mock.timers.reset();
    t.mock.restoreAll();
  }
});

test("worker signal stops cleanly and unavailable server yields a distinct diagnostic", async (t) => {
  const options = await fixture(t, packageVersion());
  const started = Promise.withResolvers<void>();
  const running = runWorker({ ...options, log: () => started.resolve() });
  await started.promise;
  process.emit("SIGTERM");
  assert.equal(await running, null);
  const error = await runWorker({ ...options, endpoint: "http://127.0.0.1:1" });
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, UNAVAILABLE_CODE);
});

test("stop waits for registration then deregisters without emitting ready", async (t) => {
  const received = Promise.withResolvers<ServerResponse>();
  let deregistrations = 0;
  const options = await fixture(t, packageVersion(), (request, response) => {
    if (request.url === REGISTER_PATH) {
      received.resolve(response);
      return true;
    }
    if (request.url === DEREGISTER_PATH) deregistrations++;
    return false;
  });
  const messages: string[] = [];
  const worker = new Worker({
    ...options,
    log: (message) => messages.push(message),
  });
  const start = worker.start();
  const response = await received.promise;
  const stop = worker.stop();
  response.writeHead(HttpStatus.OK, { "Content-Type": "application/json" });
  response.end(JSON.stringify(REGISTRATION));
  assert.equal(await start, null);
  assert.equal(await stop, null);
  assert.deepEqual(messages, []);
  assert.equal(deregistrations, ONE_RECORD);
});

test("settled stop arms a watchdog during a stalled deregistration", async (t) => {
  const received = Promise.withResolvers<ServerResponse>();
  const options = await fixture(t, packageVersion(), (request, response) => {
    if (request.url !== DEREGISTER_PATH) return false;
    received.resolve(response);
    return true;
  });
  const worker = new Worker({ ...options, log: () => {} });
  assert.equal(await worker.start(), null);
  const exits: unknown[] = [];
  t.mock.method(process, "exit", (code: unknown) => {
    exits.push(code);
    return undefined as never;
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stop = worker.stop();
  const response = await received.promise;
  t.mock.timers.tick(WORKER_STOP_WATCHDOG_MS);
  assert.deepEqual(exits, [WORKER_STOP_EXIT_FAILURE]);
  response.writeHead(HttpStatus.OK, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      runtimeIdentity: REGISTRATION.runtimeIdentity,
      registered: false,
    }),
  );
  assert.equal(await stop, null);
});
