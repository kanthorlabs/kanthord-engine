import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { decode } from "hono/jwt";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import {
  fakeMachines,
  gatewayFixture,
  humanCaller,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import { directories } from "../../config/index.ts";
import {
  kanthord as command,
  environment,
  kanthordTerminal,
  spawnKanthord,
} from "./cli-test-support.ts";
import {
  generateX25519KeyPair,
  openJSON,
  sealJSON,
} from "../../kernel/hpke.ts";
import {
  InstancePlacement,
  machineConfigurationValue,
  WorkerMethod,
  workerOperations,
} from "../../worker/contract.ts";
import { decodeMachineConfiguration } from "../worker/index.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const clientConfigPath = (env: NodeJS.ProcessEnv) =>
  join(directories(env).config, "cli.yaml");

const EMPTY_OUTPUT = "";
const STRING_TYPE = "string";
const NO_REGISTRATIONS = 0;
const SINGLE_REGISTRATION = 1;
const REGISTRATION_ATTEMPTS = 2;
const TOKEN_SOURCES = 3;
const NATIVE_AGENT = "swe@1";
const EXTERNAL_HARNESS = "claude-code";
const INVALID_PLACEMENT = "thread";

test("agent get CLI publishes the declaration and rejects a machine caller", async (t) => {
  const unauthorized = 401;
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const leaf = ["agent", "get"];
  const help = await command([...leaf, "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const response = await fetch(`${fixture.endpoint}/api/agent/swe%401`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, unauthorized);
});

test("agent prompt resolve CLI answers scheduler.execution.not_found with the execution of an absent execution", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const execution = "execution_absent";
  const absent = await command(
    [
      "agent",
      "prompt",
      "resolve",
      "--execution",
      execution,
      "--agent",
      NATIVE_AGENT,
    ],
    env,
  );
  assert.equal(absent.code, ExitCode.Failure);
  assert.equal(absent.stdout, EMPTY_OUTPUT);
  assert.match(absent.stderr, /^scheduler\.execution\.not_found:/);
  const details = /^details: (.+)$/m.exec(absent.stderr)?.[1];
  assert.ok(details, absent.stderr);
  assert.deepEqual(JSON.parse(details), { execution_id: execution });
});

test("deregistration CLI validates identity and token and returns replayable JSON", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const leaf = ["worker", "registration", "deregister"];
  const help = await command([...leaf, "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  const invalid = await command([...leaf, "invalid"], env);
  assert.match(
    invalid.stderr,
    /^cli.worker.registration.deregister.invalid_runtime_identity:/,
  );
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const registered = await command(
    ["worker", "register", "--token", token],
    env,
  );
  assert.equal(registered.code, ExitCode.Success, registered.stderr);
  const { runtime_identity: runtimeIdentity } = JSON.parse(registered.stdout);
  const absent = await command([...leaf, runtimeIdentity], env);
  assert.match(
    absent.stderr,
    /^cli.worker.registration.deregister.token_required:/,
  );
  const key = createIdempotencyKey();
  const ended = await command(
    [...leaf, runtimeIdentity, "--token", token, "--idempotency-key", key],
    env,
  );
  assert.equal(ended.code, ExitCode.Success, ended.stderr);
  assert.deepEqual(JSON.parse(ended.stdout), {
    runtime_identity: runtimeIdentity,
    registered: false,
    idempotency_key: key,
  });
});

test("heartbeat CLI has offline help, requires a token and prints null after registration", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const help = await command(["worker", "heartbeat", "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  const absent = await command(["worker", "heartbeat"], env);
  assert.equal(absent.code, ExitCode.Failure);
  assert.match(absent.stderr, /^cli.worker.heartbeat.token_required:/);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const registered = await command(
    ["worker", "register", "--token", token],
    env,
  );
  assert.equal(registered.code, ExitCode.Success, registered.stderr);
  const heartbeat = await command(
    ["worker", "heartbeat", "--token", token],
    env,
  );
  assert.equal(heartbeat.code, ExitCode.Success, heartbeat.stderr);
  assert.equal(JSON.parse(heartbeat.stdout), null);
});

test("resume CLI validates input and token and denies machine access", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const leaf = ["worker", "registration", "resume"];
  assert.equal(
    (await command([...leaf, "--help"], env)).code,
    ExitCode.Success,
  );
  const invalid = await command([...leaf, "invalid"], env);
  assert.equal(invalid.code, ExitCode.Failure);
  assert.match(
    invalid.stderr,
    /^cli.worker.registration.resume.invalid_runtime_identity:/,
  );
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const registration = await command(
    ["worker", "register", "--token", token],
    env,
  );
  assert.equal(registration.code, ExitCode.Success, registration.stderr);
  const { runtime_identity: runtimeIdentity } = JSON.parse(registration.stdout);
  const absent = await command([...leaf, runtimeIdentity], env);
  assert.equal(absent.code, ExitCode.Failure);
  assert.match(
    absent.stderr,
    /^cli.worker.registration.resume.token_required:/,
  );
  const refused = await command(
    [...leaf, runtimeIdentity, "--token", token],
    env,
  );
  assert.equal(refused.code, ExitCode.Failure);
  assert.match(refused.stderr, /^gateway.authentication.unauthorized:/);
});

test("registration inspection CLI validates filters and identity and denies machine reads", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.equal(
    (await command(["worker", "registration", "list", "--help"], env)).code,
    ExitCode.Success,
  );
  for (const [args, code] of [
    [
      ["list", "--project", "invalid"],
      "cli.worker.registration.list.invalid_project_id",
    ],
    [
      ["list", "--binding", "Invalid"],
      "cli.worker.registration.list.invalid_binding_name",
    ],
    [
      ["list", "--binding", "general"],
      "cli.worker.registration.list.binding_without_project",
    ],
    [
      ["get", "invalid"],
      "cli.worker.registration.get.invalid_runtime_identity",
    ],
  ] as const) {
    const result = await command(["worker", "registration", ...args], env);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.startsWith(`${code}:`));
  }
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const denied = await command(
    ["worker", "registration", "list", "--token", token],
    env,
  );
  assert.equal(denied.code, ExitCode.Failure);
  assert.match(denied.stderr, /^gateway.authentication.unauthorized:/);
  const page = await command(["worker", "registration", "list"], env);
  assert.equal(page.code, ExitCode.Success, page.stderr);
  assert.deepEqual(JSON.parse(page.stdout), { items: [], next_cursor: null });
  const invalidQuery = await fixture.request(
    "/api/worker/registration?resource_identity=worker:kanthord:general",
    { headers: { Authorization: `Bearer ${fixture.token}` } },
  );
  const badRequest = 400;
  const validationFailed = "gateway.request.validation_failed";
  assert.equal(invalidQuery.status, badRequest);
  assert.equal(
    errorSchema.parse(await invalidQuery.json()).error.code,
    validationFailed,
  );
});

test("worker catalog CLI lists ascending pages", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const help = await command(["worker", "list", "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  const first = await command(["worker", "list", "--limit", "1"], env);
  assert.equal(first.code, ExitCode.Success, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(
    page.items.map((item: { name: string }) => item.name),
    ["coder@1"],
  );
  assert.equal(typeof page.next_cursor, STRING_TYPE);
  const second = await command(
    ["worker", "list", "--limit", "1", "--cursor", page.next_cursor],
    env,
  );
  assert.equal(second.code, ExitCode.Success, second.stderr);
  const last = JSON.parse(second.stdout);
  assert.deepEqual(
    last.items.map((item: { name: string }) => item.name),
    ["reviewer@1"],
  );
  assert.equal(last.next_cursor, null);
});

test("worker catalog CLI gets native and external budgets and reports missing workers", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const native = await command(["worker", "get", "coder@1"], env);
  assert.equal(native.code, ExitCode.Success, native.stderr);
  const declaration = JSON.parse(native.stdout);
  assert.equal(declaration.method, WorkerMethod.Steps);
  assert.deepEqual(declaration.agent_names, [NATIVE_AGENT]);
  assert.ok(!("harness" in declaration));
  const external = await command(["worker", "get", "claude-code@1"], env);
  assert.equal(external.code, ExitCode.Success, external.stderr);
  const harness = JSON.parse(external.stdout);
  assert.equal(harness.harness, EXTERNAL_HARNESS);
  assert.ok(!("method" in harness));
  const missing = await command(["worker", "get", "tdd@1"], env);
  assert.equal(missing.code, ExitCode.Failure);
  assert.match(missing.stderr, /^worker\.catalog\.not_found:/);
  assert.equal(missing.stdout, EMPTY_OUTPUT);
});

test("worker catalog requires human access and preserves pagination errors", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: await fixture.machineToken(
      TEST_PROJECT_ID,
      TEST_WORKER_BINDING,
    ),
  };
  const refused = await command(["worker", "list"], env);
  assert.equal(refused.code, ExitCode.Failure);
  assert.match(refused.stderr, /^gateway\.authentication\.unauthorized:/);
  const missing = await command(["worker", "get", "coder@1"], {
    ...env,
    KANTHORD_TOKEN: undefined,
  });
  assert.equal(missing.code, ExitCode.Failure);
  assert.match(missing.stderr, /^cli\.worker\.get\.token_required:/);
  const invalid = await command(["worker", "list", "--cursor", "!"], {
    ...env,
    KANTHORD_TOKEN: fixture.token,
  });
  assert.equal(invalid.code, ExitCode.Failure);
  assert.match(invalid.stderr, /^system\.pagination\.cursor_invalid:/);
});

test("worker register requires a token and validates retry keys before any request", async (t) => {
  const env = environment(temporary(t));
  const help = await command(["worker", "register", "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  const missing = await command(["worker", "register"], env);
  assert.equal(missing.code, ExitCode.Failure);
  assert.equal(missing.stdout, EMPTY_OUTPUT);
  assert.match(missing.stderr, /^cli\.worker\.register\.token_required:/);
  const invalid = await command(
    [
      "worker",
      "register",
      "--token",
      "invalid-token",
      "--idempotency-key",
      "not-a-ulid",
    ],
    env,
  );
  assert.equal(invalid.code, ExitCode.Failure);
  assert.match(invalid.stderr, /^cli\.idempotency_key\.invalid:/);
  assert.doesNotMatch(invalid.stderr, /invalid-token|not-a-ulid/);
  assert.equal(existsSync(clientConfigPath(env)), false);
});

test("worker register prints registration facts and key to redirected stdout and replays one registration", async (t) => {
  const machines = fakeMachines();
  const fixture = await gatewayFixture(t, { machines });
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const env: NodeJS.ProcessEnv = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: token,
  };
  const key = createIdempotencyKey();
  const args = ["worker", "register", "--idempotency-key", key];
  let previous: unknown;
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
    const result = await command(args, env);
    assert.equal(result.code, ExitCode.Success, result.stderr);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), [
      "idempotency_key",
      "resource_identity",
      "runtime_identity",
      "worker_name",
    ]);
    assert.equal(response.idempotency_key, key);
    assert.equal(
      response.runtime_identity,
      machines.worker.findByClient(String(decode(token).payload.sub))
        ?.runtime_identity,
    );
    if (previous) assert.deepEqual(response, previous);
    previous = response;
    assert.ok(!result.stdout.includes(token));
  }
  assert.equal(machines.worker.registrations.size, SINGLE_REGISTRATION);
  assert.equal(existsSync(clientConfigPath(env)), false);
  assert.equal(existsSync(env.KANTHORD_CONFIG!), false);
});

test("worker registration resolves option over environment over file without rewriting cli.yaml", async (t) => {
  const machines = fakeMachines({
    bindings: new Map([
      [
        TEST_WORKER_BINDING,
        { projectId: TEST_PROJECT_ID, capacity: TOKEN_SOURCES },
      ],
    ]),
  });
  const fixture = await gatewayFixture(t, { machines });
  const env = environment(temporary(t));
  const fileToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
    "file",
  );
  const environmentToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
    "environment",
  );
  const optionToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
    "option",
  );
  writePrivate(
    clientConfigPath(env),
    stringify({ endpoint: fixture.endpoint, token: fileToken }),
  );
  const original = readFileSync(clientConfigPath(env), "utf8");
  const cases = [
    {
      token: fileToken,
      args: [],
      env: { ...env, KANTHORD_ENDPOINT: undefined },
    },
    {
      token: environmentToken,
      args: [],
      env: {
        ...env,
        KANTHORD_ENDPOINT: fixture.endpoint,
        KANTHORD_TOKEN: environmentToken,
      },
    },
    {
      token: optionToken,
      args: ["--token", optionToken, "--endpoint", fixture.endpoint],
      env: { ...env, KANTHORD_TOKEN: environmentToken },
    },
  ];
  for (const entry of cases) {
    const result = await command(
      ["worker", "register", ...entry.args],
      entry.env,
    );
    assert.equal(result.code, ExitCode.Success, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(
      response.runtime_identity,
      machines.worker.findByClient(String(decode(entry.token).payload.sub))
        ?.runtime_identity,
    );
    assert.match(
      response.idempotency_key,
      /^idempotency_key_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
    );
    assert.ok(!result.stdout.includes(entry.token));
  }
  assert.equal(machines.worker.registrations.size, TOKEN_SOURCES);
  assert.equal(readFileSync(clientConfigPath(env), "utf8"), original);
});

test("worker register reports declared failures and indeterminate transport with a reusable key and no JWT", async (t) => {
  const machines = fakeMachines();
  const fixture = await gatewayFixture(t, { machines });
  const token = await fixture.machineToken(TEST_PROJECT_ID, "absent");
  const env = { ...environment(temporary(t)), KANTHORD_TOKEN: token };
  const key = createIdempotencyKey();
  const args = ["worker", "register", "--idempotency-key", key];
  const refused = await command([...args, "--endpoint", fixture.endpoint], env);
  assert.equal(refused.code, ExitCode.Failure);
  assert.match(refused.stderr, /^status: +401$/m);
  assert.match(refused.stderr, new RegExp(`^idempotency_key: ${key}$`, "m"));
  const indeterminate = await command(args, env);
  assert.equal(indeterminate.code, ExitCode.Failure);
  assert.match(indeterminate.stderr, /^cli\.worker\.register\.indeterminate:/);
  assert.match(
    indeterminate.stderr,
    new RegExp(`^idempotency_key: ${key}$`, "m"),
  );
  assert.equal(refused.stdout + indeterminate.stdout, EMPTY_OUTPUT);
  assert.ok(!(refused.stderr + indeterminate.stderr).includes(token));
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});

const INSTANCE_NAME = "coder-1";
const OTHER_INSTANCE_NAME = "coder-2";
const INSTANCE_WORKER = "coder@1";
const MACHINE_NAME = "workstation";
const OTHER_MACHINE_NAME = "build-box";
const RESERVED_MACHINE_NAME = "server";
const JOIN_TIMEOUT_MS = 60000;
const SINGLE_SERVER_INSTANCE = 1;
const CONFLICT_STATUS = /^status: +409$/m;

async function instanceHuman(t: TestContext, serverInstanceLimit?: number) {
  const fixture = await gatewayFixture(t, {
    serverInstanceLimit,
  });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const create = (name: string, ...options: string[]) =>
    command(
      [
        "worker",
        "instance",
        "create",
        name,
        "--worker",
        INSTANCE_WORKER,
      ].concat(options),
      env,
    );
  const listed = async () => {
    const result = await command(["worker", "instance", "list"], env);
    assert.equal(result.code, ExitCode.Success, result.stderr);
    return JSON.parse(result.stdout).items as { name: string }[];
  };
  const createMachine = () =>
    humanCaller(fixture)(workerOperations["machine.create"], {
      params: {},
      query: {},
      body: { name: MACHINE_NAME },
    });
  return { env, create, createMachine, listed, endpoint: fixture.endpoint };
}

test("instance create at the server placement sends no key and prints a record without an instance configuration", async (t) => {
  const f = await instanceHuman(t);
  const created = await f.create(
    INSTANCE_NAME,
    "--placement",
    InstancePlacement.Server,
  );
  assert.equal(created.code, ExitCode.Success, created.stderr);
  const record = JSON.parse(created.stdout);
  assert.equal(record.name, INSTANCE_NAME);
  assert.equal(record.placement, InstancePlacement.Server);
  assert.equal(record.public_key, null);
  assert.equal(record.fingerprint, null);
  assert.ok(!("instance_configuration" in record));
  assert.deepEqual(
    (await f.listed()).map((item) => item.name),
    [INSTANCE_NAME],
  );
});

test("instance create at the worker placement keeps the key pair, the output file and the worker endpoint", async (t) => {
  const f = await instanceHuman(t);
  await f.createMachine();
  const created = await f.create(
    INSTANCE_NAME,
    "--placement",
    InstancePlacement.Worker,
    "--machine",
    MACHINE_NAME,
    "--output",
    "--worker-endpoint",
    f.endpoint,
  );
  assert.equal(created.code, ExitCode.Success, created.stderr);
  const record = JSON.parse(created.stdout);
  assert.equal(record.placement, InstancePlacement.Worker);
  assert.equal(record.machine, MACHINE_NAME);
  assert.equal(typeof record.public_key, STRING_TYPE);
  assert.equal(typeof record.fingerprint, STRING_TYPE);
  assert.ok(existsSync(record.created));
  assert.ok(!("instance_configuration" in record));
});

test("instance create at the worker placement refuses an absent machine and a machine at the server placement", async (t) => {
  const f = await instanceHuman(t);
  await f.createMachine();
  const absent = await f.create(
    INSTANCE_NAME,
    "--placement",
    InstancePlacement.Worker,
    "--output",
    "--worker-endpoint",
    f.endpoint,
  );
  const server = await f.create(
    INSTANCE_NAME,
    "--placement",
    InstancePlacement.Server,
    "--machine",
    MACHINE_NAME,
  );
  for (const result of [absent, server]) {
    assert.equal(result.code, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /^worker\.instance\.machine_invalid:/);
  }
  assert.deepEqual(await f.listed(), []);
});

test("instance create refuses a missing or invalid placement and a server placement with output locally", async (t) => {
  const f = await instanceHuman(t);
  const invalid: string[][] = [
    [],
    ["--placement", INVALID_PLACEMENT],
    ["--placement", InstancePlacement.Server, "--output"],
    [
      "--placement",
      InstancePlacement.Container,
      "--worker-endpoint",
      f.endpoint,
    ],
  ];
  for (const options of invalid) {
    const result = await f.create(INSTANCE_NAME, ...options);
    assert.equal(result.code, ExitCode.Failure);
    assert.equal(result.stdout, EMPTY_OUTPUT);
    assert.match(result.stderr, /^cli\.worker\.instance\.placement_invalid:/);
  }
  assert.deepEqual(await f.listed(), []);
});

test("instance create prints the server limit refusal like the other instance commands", async (t) => {
  const f = await instanceHuman(t, SINGLE_SERVER_INSTANCE);
  const first = await f.create(
    INSTANCE_NAME,
    "--placement",
    InstancePlacement.Server,
  );
  assert.equal(first.code, ExitCode.Success, first.stderr);
  const refused = await f.create(
    OTHER_INSTANCE_NAME,
    "--placement",
    InstancePlacement.Server,
  );
  assert.equal(refused.code, ExitCode.Failure);
  assert.equal(refused.stdout, EMPTY_OUTPUT);
  assert.match(refused.stderr, /^worker\.instance\.server_limit:/);
  assert.match(refused.stderr, CONFLICT_STATUS);
  assert.match(refused.stderr, /^idempotency_key: /m);
});

const FIRST_REVISION = "1";
const ARCHIVED_RECORD = {
  id: "worker_instance_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  name: INSTANCE_NAME,
  worker: INSTANCE_WORKER,
  revision: 1,
  placement: InstancePlacement.Server,
  machine: null,
  public_key: null,
  fingerprint: null,
  created_at: 1,
  ended_at: 2,
};

async function archiveBodies(t: TestContext, ...options: string[]) {
  const bodies: unknown[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(ARCHIVED_RECORD));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopAfter(t, () => server.close());
  const result = await command(
    [
      "worker",
      "instance",
      "archive",
      INSTANCE_NAME,
      "--expected-revision",
      FIRST_REVISION,
      ...options,
    ],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      KANTHORD_TOKEN: "human",
    },
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  return bodies;
}

test("instance archive without --force sends no force", async (t) => {
  assert.deepEqual(await archiveBodies(t), [{ expected_revision: 1 }]);
});

const MACHINE_CONFIG_EXISTS = /^cli\.worker\.machine\.config_exists:/;
const MACHINE_CONFIG_INVALID = /^worker\.machine\.config_invalid:/;
const SEAL_INFO = "kanthord/test/machine";
const SEAL_AAD = "machine";
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const FIRST_MACHINE_REVISION = "1";
const SECOND_MACHINE_REVISION = "2";

async function machineHuman(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const file = (name = MACHINE_NAME) =>
    join(directories(env).config, "machines", `${name}.yaml`);
  const run = (...args: string[]) =>
    command(["worker", "machine", ...args], env);
  const terminal = (...args: string[]) =>
    kanthordTerminal(["worker", "machine", ...args], env);
  const succeeded = async (result: ReturnType<typeof run>) => {
    const done = await result;
    assert.equal(done.code, ExitCode.Success, done.stderr);
    return JSON.parse(done.stdout);
  };
  return { env, file, run, terminal, succeeded };
}

async function opens(publicKey: string, privateKey: string) {
  const sealed = await sealJSON(
    Buffer.from(publicKey, "base64url"),
    SEAL_INFO,
    SEAL_AAD,
    { name: MACHINE_NAME },
  );
  assert.deepEqual(
    await openJSON(
      Buffer.from(privateKey, "base64url"),
      SEAL_INFO,
      SEAL_AAD,
      sealed,
    ),
    { name: MACHINE_NAME },
  );
}

test("machine create with --output sends only the public key and writes the machine file", async (t) => {
  const f = await machineHuman(t);
  const record = await f.succeeded(f.run("create", MACHINE_NAME, "--output"));
  assert.equal(record.name, MACHINE_NAME);
  assert.equal(record.created, f.file());
  assert.ok(!("machine_configuration" in record));
  assert.equal(statSync(f.file()).mode & PERMISSION_BITS, FILE_MODE);
  assert.equal(
    statSync(dirname(f.file())).mode & PERMISSION_BITS,
    DIRECTORY_MODE,
  );
  const written = parse(readFileSync(f.file(), "utf8"));
  assert.deepEqual(Object.keys(written), ["name", "private_key"]);
  await opens(record.public_key, written.private_key);
});

test("machine create without --output prints the answer with the machine configuration on a terminal only", async (t) => {
  const f = await machineHuman(t);
  const refused = await f.run("create", MACHINE_NAME);
  assert.equal(refused.code, ExitCode.Failure);
  assert.equal(refused.stdout, EMPTY_OUTPUT);
  const record = await f.succeeded(f.terminal("create", MACHINE_NAME));
  const configuration = decodeMachineConfiguration(
    record.machine_configuration,
  );
  assert.equal(configuration.name, MACHINE_NAME);
  await opens(record.public_key, configuration.private_key);
  assert.ok(!existsSync(f.file()));
});

test("machine join writes the machine file from standard input", async (t) => {
  const f = await machineHuman(t);
  const record = await f.succeeded(f.terminal("create", MACHINE_NAME));
  const joined = await spawnKanthord(
    ["worker", "machine", "join"],
    f.env,
    AbortSignal.timeout(JOIN_TIMEOUT_MS),
    record.machine_configuration,
  );
  assert.equal(joined.code, ExitCode.Success, joined.stderr);
  assert.match(joined.stdout, /^created:\s/);
  assert.equal(statSync(f.file()).mode & PERMISSION_BITS, FILE_MODE);
  const written = parse(readFileSync(f.file(), "utf8"));
  assert.equal(
    machineConfigurationValue(written),
    record.machine_configuration,
  );
});

test("machine join of a name that breaks the name form refuses and writes no file", async (t) => {
  const f = await machineHuman(t);
  const pair = await generateX25519KeyPair();
  const value = machineConfigurationValue({
    name: RESERVED_MACHINE_NAME,
    private_key: pair.private_key.toString("base64url"),
  });
  const joined = await spawnKanthord(
    ["worker", "machine", "join"],
    f.env,
    AbortSignal.timeout(JOIN_TIMEOUT_MS),
    value,
  );
  assert.equal(joined.code, ExitCode.Failure);
  assert.match(joined.stderr, MACHINE_CONFIG_INVALID);
  assert.ok(!existsSync(dirname(f.file())));
});

test("join, create --output and rotate --output refuse an existing machine file without --force", async (t) => {
  const f = await machineHuman(t);
  const record = await f.succeeded(f.terminal("create", MACHINE_NAME));
  const join = () =>
    spawnKanthord(
      ["worker", "machine", "join"],
      f.env,
      AbortSignal.timeout(JOIN_TIMEOUT_MS),
      record.machine_configuration,
    );
  assert.equal((await join()).code, ExitCode.Success);
  const before = readFileSync(f.file(), "utf8");
  const refusals = [
    await join(),
    await f.run("create", OTHER_MACHINE_NAME, "--output"),
    await f.run(
      "rotate",
      MACHINE_NAME,
      "--expected-revision",
      FIRST_MACHINE_REVISION,
      "--output",
    ),
  ];
  assert.match(refusals[0]!.stderr, MACHINE_CONFIG_EXISTS);
  assert.equal(refusals[1]!.code, ExitCode.Success, refusals[1]!.stderr);
  assert.equal(refusals[2]!.code, ExitCode.Failure);
  assert.match(refusals[2]!.stderr, MACHINE_CONFIG_EXISTS);
  assert.equal(readFileSync(f.file(), "utf8"), before);
  const created = await f.run("create", MACHINE_NAME, "--output");
  assert.equal(created.code, ExitCode.Failure);
  assert.match(created.stderr, MACHINE_CONFIG_EXISTS);
});

test("machine commands refuse a name that breaks the name form before the request", async (t) => {
  const f = await machineHuman(t);
  const invalid = await f.run("create", RESERVED_MACHINE_NAME);
  assert.match(invalid.stderr, /^worker\.machine\.name_invalid:/);
  const output = await f.run("create", RESERVED_MACHINE_NAME, "--output");
  assert.match(output.stderr, MACHINE_CONFIG_INVALID);
  const read = await f.run("get", RESERVED_MACHINE_NAME);
  assert.match(read.stderr, /^worker\.machine\.name_invalid:/);
});

test("machine list, get, rotate and archive answer the machine records", async (t) => {
  const f = await machineHuman(t);
  await f.succeeded(f.run("create", MACHINE_NAME, "--output"));
  const listed = await f.succeeded(f.run("list"));
  assert.deepEqual(
    listed.items.map((item: { name: string }) => item.name),
    [MACHINE_NAME],
  );
  const read = await f.succeeded(f.run("get", MACHINE_NAME));
  assert.deepEqual(read.instances, []);
  const rotated = await f.succeeded(
    f.run(
      "rotate",
      MACHINE_NAME,
      "--expected-revision",
      FIRST_MACHINE_REVISION,
      "--output",
      "--force",
    ),
  );
  assert.equal(rotated.revision, Number(SECOND_MACHINE_REVISION));
  const written = parse(readFileSync(f.file(), "utf8"));
  await opens(rotated.public_key, written.private_key);
  const archived = await f.succeeded(
    f.run(
      "archive",
      MACHINE_NAME,
      "--expected-revision",
      SECOND_MACHINE_REVISION,
    ),
  );
  assert.ok(archived.ended_at);
  const missing = await f.run("archive", MACHINE_NAME);
  assert.match(missing.stderr, /^cli\.worker\.machine\.revision_invalid:/);
});
