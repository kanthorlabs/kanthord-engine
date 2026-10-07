import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulidSchema } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import { environment, generateMachineToken, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const EMPTY_COUNT = 0;
const UNKNOWN_REQUEST = "outbound_request_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SYNTHETIC_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const OUTBOUND = ["intake", "outbound"];
const NOT_FOUND = "intake.outbound.request.not_found:";
const FORCE_REQUIRED = "intake.outbound.request.force_required:";
const FILTER_INVALID = "intake.outbound.request.filter_invalid:";
const INVALID_ID = "cli.intake.outbound.get.invalid_outbound_request_id:";
const VALIDATION_FAILED = "gateway.request.validation_failed:";
const UNAUTHORIZED = "gateway.authentication.unauthorized:";
const RANGE = ["--from", UNKNOWN_REQUEST, "--to", UNKNOWN_REQUEST];
const EMPTY_LIST = { items: [], next_cursor: null };

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const env = {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const run = (args: string[], override: NodeJS.ProcessEnv = env) =>
    kanthord([...OUTBOUND, ...args], override);
  return { fixture, env, run };
}

function refused(
  result: { code: number; stdout: string; stderr: string },
  prefix: string,
): void {
  assert.equal(result.code, ExitCode.Failure, result.stderr);
  assert.ok(result.stderr.startsWith(prefix), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
}

test("E02.1 outbound list answers an empty page", async (t) => {
  const { run } = await setup(t);
  const result = await run(["list"]);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), EMPTY_LIST);
  assert.equal(result.stderr, EMPTY_OUTPUT);
});

test("E02.2 outbound get and discard refuse an unknown request", async (t) => {
  const { run } = await setup(t);
  refused(await run(["get", UNKNOWN_REQUEST]), NOT_FOUND);
  refused(await run(["discard", UNKNOWN_REQUEST]), NOT_FOUND);
});

test("E02.3 outbound delete with a filter and without force refuses", async (t) => {
  const { run } = await setup(t);
  refused(await run(["delete", "--state", "failed", ...RANGE]), FORCE_REQUIRED);
});

test("E02.4 outbound delete refuses an invalid filter three times", async (t) => {
  const { run } = await setup(t);
  refused(await run(["delete", "--force"]), FILTER_INVALID);
  refused(
    await run(["delete", "--force", "--state", "pending", ...RANGE]),
    FILTER_INVALID,
  );
  refused(
    await run([
      "delete",
      "--force",
      "--state",
      "failed",
      ...RANGE,
      "--id",
      UNKNOWN_REQUEST,
    ]),
    FILTER_INVALID,
  );
});

test("E02.5 outbound delete with force and a valid filter counts zero", async (t) => {
  const { run } = await setup(t);
  const result = await run([
    "delete",
    "--force",
    "--state",
    "failed",
    ...RANGE,
  ]);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const answer = JSON.parse(result.stdout) as {
    count: number;
    idempotency_key: string;
  };
  assert.equal(answer.count, EMPTY_COUNT);
  assert.ok(
    ulidSchema.safeParse(answer.idempotency_key).success,
    result.stdout,
  );
  assert.equal(result.stderr, EMPTY_OUTPUT);
});

test("E02.6 a malformed identity and an unknown state refuse", async (t) => {
  const { run } = await setup(t);
  refused(await run(["get", "bad"]), INVALID_ID);
  refused(await run(["list", "--state", "done"]), VALIDATION_FAILED);
});

test("E02.7 a machine token lists no outbound request", async (t) => {
  const { fixture, env, run } = await setup(t);
  const machine = generateMachineToken({
    env,
    masterKey: fixture.config.master_key,
    projectId: SYNTHETIC_PROJECT_ID,
    bindingName: "general",
    name: "general-a",
  });
  refused(
    await run(["list"], { ...env, KANTHORD_TOKEN: machine.token }),
    UNAUTHORIZED,
  );
});
