import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ulid } from "ulid";
import { stringify } from "yaml";
import { decode } from "hono/jwt";
import { temporary } from "../../kernel/test-support.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";
import { writePrivate } from "../../kernel/files.ts";
import { directories } from "../../config/index.ts";
import { kanthord as command, environment } from "./cli-support.ts";
import { WorkerMethod } from "../../worker/contract.ts";
import { errorSchema } from "../../kernel/errors.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const clientConfigPath = (env: NodeJS.ProcessEnv) =>
  join(directories(env).config, "cli.yaml");

const EMPTY_OUTPUT = "";
const NO_REGISTRATIONS = 0;
const SINGLE_REGISTRATION = 1;
const REGISTRATION_ATTEMPTS = 2;
const TOKEN_SOURCES = 3;
const STRING_TYPE = "string";
const NATIVE_AGENT = "swe@1";
const EXTERNAL_HARNESS = "claude-code";

test("agent get CLI publishes the declaration and rejects a machine caller", async (t) => {
  const unauthorized = 401;
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const leaf = ["worker", "agent", "get"];
  const help = await command([...leaf, "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  assert.match(help.stdout, /agent-name/);
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const response = await fetch(`${fixture.endpoint}/api/worker/agent/swe%401`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, unauthorized);
});

test("deregistration CLI validates identity and token and returns replayable JSON", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
  };
  const leaf = ["worker", "instance", "deregister"];
  const help = await command([...leaf, "--help"], env);
  assert.equal(help.code, ExitCode.Success);
  assert.match(help.stdout, /machine JWT/);
  assert.doesNotMatch(help.stdout, /Human JWT/);
  const invalid = await command([...leaf, "invalid"], env);
  assert.match(
    invalid.stderr,
    /^cli.worker.instance.deregister.invalid_runtime_identity:/,
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
  const { runtimeIdentity } = JSON.parse(registered.stdout);
  const absent = await command([...leaf, runtimeIdentity], env);
  assert.match(
    absent.stderr,
    /^cli.worker.instance.deregister.token_required:/,
  );
  const key = ulid();
  const ended = await command(
    [...leaf, runtimeIdentity, "--token", token, "--idempotency-key", key],
    env,
  );
  assert.equal(ended.code, ExitCode.Success, ended.stderr);
  assert.deepEqual(JSON.parse(ended.stdout), {
    runtimeIdentity,
    registered: false,
    idempotencyKey: key,
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
  const leaf = ["worker", "instance", "resume"];
  assert.equal(
    (await command([...leaf, "--help"], env)).code,
    ExitCode.Success,
  );
  const invalid = await command([...leaf, "invalid"], env);
  assert.equal(invalid.code, ExitCode.Failure);
  assert.match(
    invalid.stderr,
    /^cli.worker.instance.resume.invalid_runtime_identity:/,
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
  const { runtimeIdentity } = JSON.parse(registration.stdout);
  const absent = await command([...leaf, runtimeIdentity], env);
  assert.equal(absent.code, ExitCode.Failure);
  assert.match(absent.stderr, /^cli.worker.instance.resume.token_required:/);
  const refused = await command(
    [...leaf, runtimeIdentity, "--token", token],
    env,
  );
  assert.equal(refused.code, ExitCode.Failure);
  assert.match(refused.stderr, /^gateway.authentication.unauthorized:/);
});

test("instance inspection CLI validates filters and identity and denies machine reads", async (t) => {
  const fixture = await gatewayFixture(t, { machines: fakeMachines() });
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.equal(
    (await command(["worker", "instance", "list", "--help"], env)).code,
    ExitCode.Success,
  );
  for (const [args, code] of [
    [
      ["list", "--project", "invalid"],
      "cli.worker.instance.list.invalid_project_id",
    ],
    [
      ["list", "--binding", "Invalid"],
      "cli.worker.instance.list.invalid_binding_name",
    ],
    [
      ["list", "--binding", "general"],
      "cli.worker.instance.list.binding_without_project",
    ],
    [["get", "invalid"], "cli.worker.instance.get.invalid_runtime_identity"],
  ] as const) {
    const result = await command(["worker", "instance", ...args], env);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.startsWith(`${code}:`));
  }
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const denied = await command(
    ["worker", "instance", "list", "--token", token],
    env,
  );
  assert.equal(denied.code, ExitCode.Failure);
  assert.match(denied.stderr, /^gateway.authentication.unauthorized:/);
  const page = await command(["worker", "instance", "list"], env);
  assert.equal(page.code, ExitCode.Success, page.stderr);
  assert.deepEqual(JSON.parse(page.stdout), { items: [], nextCursor: null });
  const invalidQuery = await fixture.request(
    "/api/worker/instance?resourceIdentity=worker:kanthord:general",
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
  assert.match(help.stdout, /--cursor/);
  const first = await command(["worker", "list", "--limit", "2"], env);
  assert.equal(first.code, ExitCode.Success, first.stderr);
  const page = JSON.parse(first.stdout);
  assert.deepEqual(
    page.items.map((item: { name: string }) => item.name),
    ["claude@1", "general@1"],
  );
  assert.equal(typeof page.nextCursor, STRING_TYPE);
  const second = await command(
    ["worker", "list", "--limit", "2", "--cursor", page.nextCursor],
    env,
  );
  assert.equal(second.code, ExitCode.Success, second.stderr);
  const last = JSON.parse(second.stdout);
  assert.deepEqual(
    last.items.map((item: { name: string }) => item.name),
    ["opencode@1", "reviewer@1"],
  );
  assert.equal(last.nextCursor, null);
});

test("worker catalog CLI gets native and external budgets and reports missing workers", async (t) => {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const native = await command(["worker", "get", "general@1"], env);
  assert.equal(native.code, ExitCode.Success, native.stderr);
  const declaration = JSON.parse(native.stdout);
  assert.deepEqual(declaration.resourceBudget, {
    turns: 200,
    wallTimeMs: 7200000,
  });
  assert.equal(declaration.method, WorkerMethod.Steps);
  assert.equal(declaration.agentName, NATIVE_AGENT);
  assert.ok(!("harness" in declaration));
  const external = await command(["worker", "get", "claude@1"], env);
  assert.equal(external.code, ExitCode.Success, external.stderr);
  const harness = JSON.parse(external.stdout);
  assert.deepEqual(harness.resourceBudget, { wallTimeMs: 7200000 });
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
  const missing = await command(["worker", "get", "general@1"], {
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
  assert.match(help.stdout, /--token <jwt>/);
  assert.match(help.stdout, /runtime identity/);
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
  assert.match(
    invalid.stderr,
    /^cli\.worker\.register\.invalid_idempotency_key:/,
  );
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
  const key = ulid();
  const args = ["worker", "register", "--idempotency-key", key];
  let previous: unknown;
  for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
    const result = await command(args, env);
    assert.equal(result.code, ExitCode.Success, result.stderr);
    assert.equal(result.stderr, EMPTY_OUTPUT);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(response).sort(), [
      "idempotencyKey",
      "resourceIdentity",
      "runtimeIdentity",
      "workerName",
    ]);
    assert.equal(response.idempotencyKey, key);
    assert.equal(
      response.runtimeIdentity,
      machines.worker.findByClient(String(decode(token).payload.sub))
        ?.runtimeIdentity,
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
      response.runtimeIdentity,
      machines.worker.findByClient(String(decode(entry.token).payload.sub))
        ?.runtimeIdentity,
    );
    assert.match(response.idempotencyKey, /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
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
  const key = ulid();
  const args = ["worker", "register", "--idempotency-key", key];
  const refused = await command([...args, "--endpoint", fixture.endpoint], env);
  assert.equal(refused.code, ExitCode.Failure);
  assert.match(refused.stderr, /HTTP 401/);
  assert.ok(refused.stderr.includes(key));
  const indeterminate = await command(args, env);
  assert.equal(indeterminate.code, ExitCode.Failure);
  assert.match(indeterminate.stderr, /^cli\.worker\.register\.indeterminate:/);
  assert.ok(indeterminate.stderr.includes(`--idempotency-key ${key}`));
  assert.equal(refused.stdout + indeterminate.stdout, EMPTY_OUTPUT);
  assert.ok(!(refused.stderr + indeterminate.stderr).includes(token));
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
});
