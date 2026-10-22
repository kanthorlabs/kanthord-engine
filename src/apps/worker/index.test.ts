import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CancellationContext } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { hostEnvironment, temporary } from "../../kernel/test-support.ts";
import { isObject } from "../../kernel/values.ts";
import { packageVersion } from "../../kernel/version.ts";
import { WorkPullKind } from "../../scheduler/contract.ts";
import { Worker, runWorker, type WorkerOptions } from "./index.ts";
import {
  FAKE_INSTANCE_NAME,
  FAKE_WORKER,
  FakePath,
  fakeInstanceServer,
  testClaim,
} from "./test-support.ts";

const INSTANCE_READY = "Worker instance ready";
const REGISTRATION_READY = "Worker application ready";
const MSG_KEY = '"msg":';
const MISMATCH_VERSION = "0.0.0-mismatch";
const MISMATCH_CODE = "worker.version.mismatch";
const UNAVAILABLE_CODE = "worker.version.unavailable";
const SUPERSEDED_CODE = "worker.instance.superseded";
const SECRET_CHANGED_CODE = "worker.instance.secret_changed";
const ANSWER_INVALID = "gateway.client.answer_invalid";
const CONFIG_ABSENT = "worker.start.instance_config_absent";
const ENDPOINT_INSECURE = "worker.start.endpoint_insecure";
const CONNECTION_A = "host-a";
const CONNECTION_B = "host-b";
const UNREACHABLE_ENDPOINT = "http://127.0.0.1:1";
const PUBLIC_ENDPOINT = "http://kanthord.example:31415";
const PUBLIC_ADDRESS = "203.0.113.7";
const FAST_HEARTBEAT_MS = 50;
const SLOW_INTERVAL_MS = 3600000;
const RENEWAL_MS = 150;
const REARM_RENEWAL_MS = 400;
const REARM_WINDOWS = 4;
const SUPERSEDE_TIMEOUT_MS = 60000;
const POLL_MS = 10;
const NO_WORK_DELAY_MS = 20;
const TWO_BINDINGS = 2;
const SINGLE = 1;
const EXIT_SUCCESS = 0;
const WORKER_STOP_WATCHDOG_MS = 10000;
const AFTER_WATCHDOG_MS = WORKER_STOP_WATCHDOG_MS + 1;
const PROOF_FAILED = {
  status: HttpStatus.Forbidden,
  body: {
    error: {
      code: "gateway.invocation.execution_proof_failed",
      message: "The execution is not a live claim of this registration.",
      details: null,
    },
    request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};
const UNAUTHORIZED = {
  status: HttpStatus.Unauthorized,
  body: {
    error: {
      code: "gateway.authentication.unauthorized",
      message: "The bearer is not valid.",
      details: null,
    },
    request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};
const NOT_LISTED = {
  status: HttpStatus.Unauthorized,
  body: {
    error: {
      code: "gateway.jwt.instance_not_listed",
      message: "The binding does not list the instance.",
      details: null,
    },
    request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};
const CHILD_SCRIPT = `
  import { runWorker } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
  const error = await runWorker({});
  if (error) { process.stderr.write(error.message); process.exitCode = 1; }
`;

async function until<T>(
  read: () => T | undefined | false,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    const value = read();
    if (value) return value;
    await delay(POLL_MS, undefined, { signal });
  }
}

function environmentOf(t: TestContext, value?: string): NodeJS.ProcessEnv {
  const root = temporary(t);
  return {
    HOME: root,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_DATA_HOME: `${root}/data`,
    XDG_STATE_HOME: `${root}/state`,
    ...(value === undefined ? {} : { KANTHORD_WORKER_CONFIG: value }),
  };
}

async function fixture(t: TestContext, bindings = TWO_BINDINGS) {
  const server = await fakeInstanceServer(t);
  for (let index = 0; index < bindings; index++)
    server.addBinding(`binding-${index}`);
  const env = environmentOf(t, server.value);
  const records: Record<string, unknown>[] = [];
  const options = (extra: Partial<WorkerOptions> = {}): WorkerOptions => ({
    env,
    connectionName: CONNECTION_A,
    heartbeatIntervalMs: SLOW_INTERVAL_MS,
    renewalIntervalMs: SLOW_INTERVAL_MS,
    log: (line) => records.push(JSON.parse(line)),
    ...extra,
  });
  const ready = (count = bindings) =>
    until(
      () =>
        records.filter((record) => record.msg === REGISTRATION_READY).length >=
        count,
      t.signal,
    );
  return { server, env, records, options, ready };
}

test("startup resolves the configuration, takes a token, logs the ready record, connects and registers each binding", async (t) => {
  const f = await fixture(t);
  const worker = new Worker(f.options());
  try {
    assert.equal(await worker.start(), null);
    assert.deepEqual(
      f.server.state.requests.slice(0, 3).map((request) => request.path),
      [FakePath.Token, FakePath.Connect, FakePath.OpenAPI],
    );
    assert.deepEqual(f.records[0], {
      msg: INSTANCE_READY,
      instance: FAKE_INSTANCE_NAME,
      worker: FAKE_WORKER,
      fingerprint: f.records[0]!.fingerprint,
      connection_name: CONNECTION_A,
      config_source: "env",
    });
    assert.match(String(f.records[0]!.fingerprint), /^SHA256:/);
    assert.equal(
      f.records.filter((record) => record.msg === REGISTRATION_READY).length,
      TWO_BINDINGS,
    );
    assert.equal(f.server.requestsTo(FakePath.Register).length, TWO_BINDINGS);
    assert.deepEqual(await worker.healthcheck(), {
      client: HealthStatus.Healthy,
    });
    const serialized = JSON.stringify(f.records);
    assert.ok(!serialized.includes(f.server.configuration.private_key));
    assert.ok(!serialized.includes(f.server.value));
  } finally {
    assert.equal(await worker.stop(), null);
  }
  assert.equal(f.server.state.deregistered.length, TWO_BINDINGS);
});

test("a token answer with another server version refuses the start before the connection", async (t) => {
  const f = await fixture(t);
  f.server.state.version = MISMATCH_VERSION;
  const error = await new Worker(f.options()).start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISMATCH_CODE);
  assert.deepEqual(error.fields, [
    ["version", packageVersion()],
    ["server_version", MISMATCH_VERSION],
  ]);
  assert.deepEqual(f.server.requestsTo(FakePath.Connect), []);
  assert.deepEqual(f.records, []);
});

test("an unavailable server and an absent configuration refuse the start with distinct codes", async (t) => {
  const f = await fixture(t);
  const unavailable = await runWorker(
    f.options({ endpoint: UNREACHABLE_ENDPOINT }),
  );
  assert.ok(unavailable instanceof Diagnostic);
  assert.equal(unavailable.code, UNAVAILABLE_CODE);
  const absent = await runWorker(
    f.options({ env: environmentOf(t), instance: FAKE_INSTANCE_NAME }),
  );
  assert.ok(absent instanceof Diagnostic);
  assert.equal(absent.code, CONFIG_ABSENT);
  assert.deepEqual(f.server.state.requests, []);
});

test("a stop during the start ends the run with no error", async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers<void>();
  let held = false;
  f.server.state.intercept = async (request) => {
    if (request.path !== FakePath.Connect || held) return undefined;
    held = true;
    await gate.promise;
    return undefined;
  };
  const worker = new Worker(f.options());
  t.after(() => worker.stop());
  const running = worker.run();
  await until(() => held, t.signal);
  const stopped = worker.stop();
  gate.resolve();
  assert.equal(await stopped, null);
  assert.equal(await running, null);
});

test("an http endpoint outside the private address set refuses the start before any request", async (t) => {
  const f = await fixture(t);
  const error = await new Worker(
    f.options({
      endpoint: PUBLIC_ENDPOINT,
      addressLookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    }),
  ).start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, ENDPOINT_INSECURE);
  assert.deepEqual(f.server.state.requests, []);
});

test("a heartbeat with another server_version stops the unit", async (t) => {
  const f = await fixture(t);
  const worker = new Worker(
    f.options({ heartbeatIntervalMs: FAST_HEARTBEAT_MS }),
  );
  t.after(() => worker.stop());
  const running = worker.run();
  await f.ready();
  f.server.state.version = MISMATCH_VERSION;
  const error = await running;
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISMATCH_CODE);
  assert.equal(f.server.state.deregistered.length, TWO_BINDINGS);
});

test(
  "a second process supersedes the first, and the first ends as superseded without a deregistration",
  { timeout: SUPERSEDE_TIMEOUT_MS },
  async (t) => {
    const f = await fixture(t);
    const firstWorker = new Worker(
      f.options({ heartbeatIntervalMs: FAST_HEARTBEAT_MS }),
    );
    t.after(() => firstWorker.stop());
    const first = firstWorker.run();
    await f.ready();
    const second = new Worker(f.options({ connectionName: CONNECTION_B }));
    t.after(() => second.stop());
    const secondRun = second.run();
    const error = await first;
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, SUPERSEDED_CODE);
    assert.deepEqual(error.fields, [["connection_name", CONNECTION_B]]);
    assert.deepEqual(f.server.state.deregistered, []);
    assert.equal(await second.start(), null);
    assert.equal(await second.stop(), null);
    assert.equal(await secondRun, null);
  },
);

test(
  "a client request refused as superseded sends one heartbeat and ends the process",
  { timeout: SUPERSEDE_TIMEOUT_MS },
  async (t) => {
    const f = await fixture(t, SINGLE);
    const gate = Promise.withResolvers<void>();
    let held = false;
    f.server.state.intercept = async (request) => {
      if (request.path !== FakePath.Pull || held) return undefined;
      held = true;
      await gate.promise;
      return undefined;
    };
    const firstWorker = new Worker(f.options());
    t.after(() => firstWorker.stop());
    const first = firstWorker.run();
    await f.ready();
    await until(() => held, t.signal);
    const heartbeats = await until(
      () => f.server.requestsTo(FakePath.InstanceHeartbeat).length,
      t.signal,
    );
    const second = new Worker(f.options({ connectionName: CONNECTION_B }));
    t.after(() => second.stop());
    assert.equal(await second.start(), null);
    gate.resolve();
    const error = await first;
    assert.ok(error instanceof Diagnostic);
    assert.equal(error.code, SUPERSEDED_CODE);
    assert.equal(
      f.server.requestsTo(FakePath.InstanceHeartbeat).length,
      heartbeats + SINGLE,
    );
    assert.equal(await second.stop(), null);
  },
);

test("an execution passes one token renewal and the next request carries the renewed client token", async (t) => {
  const f = await fixture(t, SINGLE);
  const handover = Promise.withResolvers<void>();
  let pulls = 0;
  f.server.state.intercept = async (request) => {
    if (request.path === FakePath.Pull && ++pulls === SINGLE) {
      const claim = testClaim();
      return {
        status: HttpStatus.OK,
        body: { kind: WorkPullKind.Claimed, execution: claim },
      };
    }
    if (request.path === FakePath.Pull)
      return { status: HttpStatus.OK, body: { kind: WorkPullKind.NoWork } };
    if (request.path === FakePath.Handover) {
      await handover.promise;
      return PROOF_FAILED;
    }
    return undefined;
  };
  const worker = new Worker(f.options({ renewalIntervalMs: RENEWAL_MS }));
  t.after(() => worker.stop());
  const running = worker.run();
  const held = await until(
    () => f.server.requestsTo(FakePath.Handover)[0],
    t.signal,
  );
  await until(
    () =>
      f.server.state.requests
        .slice(f.server.state.requests.indexOf(held))
        .some((request) => request.path === FakePath.Connect),
    t.signal,
  );
  assert.equal(f.server.requestsTo(FakePath.Token).length > SINGLE, true);
  handover.resolve();
  const next = await until(
    () =>
      f.server
        .requestsTo(FakePath.Pull)
        .find((request) => request.bearer !== held.bearer),
    t.signal,
  );
  assert.ok(f.server.state.clientTokens.has(next.bearer!));
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Healthy,
  });
  assert.equal(await worker.stop(), null);
  assert.equal(await running, null);
});

test("each connect answer re-arms the renewal timer", async (t) => {
  const f = await fixture(t, SINGLE);
  const worker = new Worker(
    f.options({
      heartbeatIntervalMs: FAST_HEARTBEAT_MS,
      renewalIntervalMs: REARM_RENEWAL_MS,
    }),
  );
  const running = worker.run();
  try {
    await f.ready();
    const tokens = f.server.requestsTo(FakePath.Token).length;
    const deadline = Date.now() + REARM_RENEWAL_MS * REARM_WINDOWS;
    while (Date.now() < deadline) {
      const connects = f.server.requestsTo(FakePath.Connect).length;
      f.server.state.bindingVersion++;
      while (f.server.requestsTo(FakePath.Connect).length === connects)
        await delay(POLL_MS, undefined, { signal: t.signal });
      await delay(REARM_RENEWAL_MS / REARM_WINDOWS);
    }
    assert.equal(f.server.requestsTo(FakePath.Token).length, tokens);
    while (f.server.requestsTo(FakePath.Token).length === tokens)
      await delay(POLL_MS, undefined, { signal: t.signal });
  } finally {
    assert.equal(await worker.stop(), null);
    assert.equal(await running, null);
  }
});

test("an auth-version increment with a changed client secret ends the process, and the restart resumes the running execution", async (t) => {
  const f = await fixture(t, SINGLE);
  const worker = new Worker(
    f.options({ heartbeatIntervalMs: FAST_HEARTBEAT_MS }),
  );
  t.after(() => worker.stop());
  const running = worker.run();
  await f.ready();
  const runtime = [...f.server.state.runtimes.values()][0]!;
  f.server.state.workerTokens.clear();
  f.server.state.clientTokens.clear();
  f.server.state.bindings[0]!.client_secret = Buffer.alloc(32, 7).toString(
    "base64",
  );
  const error = await running;
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, SECRET_CHANGED_CODE);
  assert.deepEqual(f.server.state.deregistered, []);
  const claim = {
    ...testClaim(),
    claimant: {
      ...testClaim().claimant,
      runtime_identity: runtime,
      resource_identity: f.server.state.bindings[0]!.resource_identity,
    },
  };
  f.server.state.intercept = (request) => {
    if (request.path === FakePath.Pull)
      return {
        status: HttpStatus.OK,
        body: { kind: WorkPullKind.Claimed, execution: claim },
      };
    if (request.path === FakePath.Handover) return PROOF_FAILED;
    return undefined;
  };
  const restarted = new Worker(f.options());
  t.after(() => restarted.stop());
  const again = restarted.run();
  const resumed = await until(
    () => f.server.requestsTo(FakePath.Handover)[0],
    t.signal,
  );
  assert.deepEqual(resumed.body, { execution_id: claim.execution_id });
  const registrations = f.records.filter(
    (record) => record.msg === REGISTRATION_READY,
  );
  assert.equal(registrations.at(-1)!.runtime_identity, runtime);
  f.server.state.intercept = undefined;
  await restarted.stop();
  await again;
});

test("a client request refused after an auth-version increment ends the process as secret_changed", async (t) => {
  const f = await fixture(t, SINGLE);
  const gate = Promise.withResolvers<void>();
  let held = false;
  f.server.state.intercept = async (request) => {
    if (request.path !== FakePath.Pull) return undefined;
    if (held) return UNAUTHORIZED;
    held = true;
    await gate.promise;
    return UNAUTHORIZED;
  };
  const worker = new Worker(f.options());
  t.after(() => worker.stop());
  const running = worker.run();
  await f.ready();
  await until(() => held, t.signal);
  f.server.state.workerTokens.clear();
  f.server.state.clientTokens.clear();
  f.server.state.bindings[0]!.client_secret = Buffer.alloc(32, 7).toString(
    "base64",
  );
  gate.resolve();
  const error = await running;
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, SECRET_CHANGED_CODE);
  assert.deepEqual(f.server.state.deregistered, []);
});

test("a removed binding ends only its own entry while another binding completes its execution", async (t) => {
  const f = await fixture(t);
  const [removed, kept] = f.server.state.bindings as [
    (typeof f.server.state.bindings)[number],
    (typeof f.server.state.bindings)[number],
  ];
  const removedPull = (request: { bearer: string | null }) =>
    request.bearer?.startsWith(`client-${removed.client_id}-`) === true;
  const handover = Promise.withResolvers<void>();
  let claimed = false;
  f.server.state.intercept = async (request) => {
    if (request.path === FakePath.Handover) {
      await handover.promise;
      return PROOF_FAILED;
    }
    if (request.path !== FakePath.Pull) return undefined;
    if (removedPull(request))
      return f.server.state.bindings.includes(removed) ? undefined : NOT_LISTED;
    if (claimed) return undefined;
    claimed = true;
    return {
      status: HttpStatus.OK,
      body: { kind: WorkPullKind.Claimed, execution: testClaim() },
    };
  };
  const worker = new Worker(f.options());
  t.after(() => worker.stop());
  let settled = false;
  const running = worker.run().finally(() => {
    settled = true;
  });
  await f.ready();
  const held = await until(
    () => f.server.requestsTo(FakePath.Handover)[0],
    t.signal,
  );
  const removedRuntime = f.server.state.runtimes.get(removed.client_id);
  f.server.state.bindings = [kept];
  f.server.state.bindingVersion++;
  handover.resolve();
  await until(
    () =>
      f.server.state.requests
        .slice(f.server.state.requests.indexOf(held))
        .some((request) => request.path === FakePath.Connect),
    t.signal,
  );
  await until(
    () =>
      f.server
        .requestsTo(FakePath.Pull)
        .filter((request) => !removedPull(request)).length > SINGLE,
    t.signal,
  );
  assert.equal(settled, false);
  assert.deepEqual(f.server.state.deregistered, []);
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Healthy,
  });
  assert.equal(await worker.stop(), null);
  assert.equal(await running, null);
  assert.equal(f.server.state.deregistered.length, SINGLE);
  assert.ok(
    !(f.server.state.deregistered as string[]).includes(removedRuntime!),
  );
});

test("a binding version change adds a new binding and drains a dropped binding", async (t) => {
  const f = await fixture(t, SINGLE);
  const worker = new Worker(
    f.options({ heartbeatIntervalMs: FAST_HEARTBEAT_MS }),
  );
  t.after(() => worker.stop());
  const running = worker.run();
  await f.ready();
  const dropped = f.server.state.bindings[0]!;
  f.server.addBinding("added");
  dropped.state = "draining";
  f.server.state.bindingVersion++;
  await f.ready(TWO_BINDINGS);
  await until(() => f.server.state.deregistered.length === SINGLE, t.signal);
  assert.equal(await worker.stop(), null);
  assert.equal(await running, null);
  assert.equal(f.server.state.deregistered.length, TWO_BINDINGS);
});

test("stop aborts each outstanding pull and deregisters each registration", async (t) => {
  const f = await fixture(t);
  const worker = new Worker(f.options());
  t.after(() => worker.stop());
  const running = worker.run();
  await until(
    () => f.server.requestsTo(FakePath.Pull).length === TWO_BINDINGS,
    t.signal,
  );
  const context = new CancellationContext();
  context.cancel();
  assert.equal(await worker.stop(), null);
  assert.equal(await running, null);
  assert.equal(f.server.state.deregistered.length, TWO_BINDINGS);
});

test("an invalid pull answer exits with its diagnostic and keeps the registration", async (t) => {
  const f = await fixture(t, SINGLE);
  f.server.state.intercept = (request) =>
    request.path === FakePath.Pull
      ? {
          status: HttpStatus.OK,
          body: {
            kind: WorkPullKind.Claimed,
            execution: { ...testClaim(), future_field: "x" },
          },
        }
      : undefined;
  const result = await runWorker(f.options());
  assert.ok(result instanceof Diagnostic);
  assert.equal(result.code, ANSWER_INVALID);
  assert.equal(f.server.requestsTo(FakePath.Pull).length, SINGLE);
  assert.deepEqual(f.server.state.deregistered, []);
});

test("SIGHUP leaves the worker healthy and the handlers leave at termination", async (t) => {
  const f = await fixture(t, SINGLE);
  const before = process.listenerCount("SIGHUP");
  const worker = new Worker(f.options());
  t.after(() => worker.stop());
  const running = worker.run();
  await f.ready();
  process.emit("SIGHUP");
  await delay(NO_WORK_DELAY_MS);
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Healthy,
  });
  process.emit("SIGTERM");
  assert.equal(await running, null);
  assert.equal(process.listenerCount("SIGHUP"), before);
});

test("the stop watchdog starts only after an unresolved startup settles", async (t) => {
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

test("the default worker log writes JSON lines on stderr without the instance configuration", async (t) => {
  const f = await fixture(t, SINGLE);
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", CHILD_SCRIPT],
    {
      env: { ...hostEnvironment(), ...f.env },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  const started = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<number | null>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.includes(`${REGISTRATION_READY}"`)) started.resolve();
  });
  child.on("exit", (code) => {
    started.reject(new Error(`Worker exited before startup: ${stderr}`));
    exited.resolve(code);
  });
  try {
    await started.promise;
    child.kill("SIGTERM");
    assert.equal(await exited.promise, EXIT_SUCCESS);
    const records: unknown[] = stderr
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(
      records.some(
        (record) =>
          isObject(record) &&
          (record as { msg?: unknown }).msg === INSTANCE_READY,
      ),
    );
    assert.deepEqual(
      stderr
        .split("\n")
        .filter(Boolean)
        .filter((line) => line.indexOf(MSG_KEY) !== line.lastIndexOf(MSG_KEY)),
      [],
    );
    assert.ok(!stderr.includes(f.server.configuration.private_key));
    assert.ok(!stderr.includes(f.server.value));
  } finally {
    child.kill("SIGKILL");
  }
});

test("the healthcheck is unavailable before the start", async () => {
  const worker = new Worker();
  assert.deepEqual(await worker.healthcheck(), {
    client: HealthStatus.Unavailable,
  });
  assert.equal(await worker.stop(), null);
});
