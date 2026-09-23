import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { ulid } from "ulid";
import { stringify } from "yaml";
import { decode } from "hono/jwt";
import {
  fakeMachines,
  gatewayFixture,
  temporary,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "../../test-support.ts";
import { isNumber } from "../../shared/values.ts";
import { writePrivate } from "../../shared/files.ts";
import { ExitCode } from "./constants.ts";
import { clientConfigPath } from "./client-config.ts";

const EMPTY_OUTPUT = "";
const NO_REGISTRATIONS = 0;
const SINGLE_REGISTRATION = 1;
const EMPTY_ARGUMENT_COUNT = 0;
const REGISTRATION_ATTEMPTS = 2;
const TOKEN_SOURCES = 3;

function command(args: string[], env: NodeJS.ProcessEnv) {
  assert.ok(args.length > EMPTY_ARGUMENT_COUNT);
  assert.ok(env.XDG_CONFIG_HOME);
  const entry = new URL("../../main.ts", import.meta.url).href;
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
        ],
        { env, timeout: 10000 },
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
    },
  );
}

function environment(directory: string): NodeJS.ProcessEnv {
  assert.ok(directory.startsWith("/"));
  assert.ok(existsSync(directory));
  return {
    ...process.env,
    XDG_CONFIG_HOME: directory,
    KANTHORD_CONFIG: join(directory, "absent.yaml"),
    KANTHORD_ENDPOINT: "http://127.0.0.1:1",
    KANTHORD_TOKEN: undefined,
  };
}

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

test("worker register prints only the runtime identity and key to redirected stdout and replays one registration", async (t) => {
  const machines = fakeMachines();
  const fixture = await gatewayFixture(t, { machines });
  const token = await fixture.machineToken(TEST_WORKER_BINDING);
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
      "runtimeIdentity",
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
  const fileToken = await fixture.machineToken(TEST_WORKER_BINDING, "file");
  const environmentToken = await fixture.machineToken(
    TEST_WORKER_BINDING,
    "environment",
  );
  const optionToken = await fixture.machineToken(TEST_WORKER_BINDING, "option");
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
  const token = await fixture.machineToken("absent");
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
