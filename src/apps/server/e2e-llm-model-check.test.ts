import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  type FauxResponseStep,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { loadPi } from "../../agent/pi.ts";
import { writePrivate } from "../../kernel/files.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import { ModelCheckResult } from "../../llm/contract.ts";
import { scriptedModelRuntime } from "../../llm/test-support.ts";
import { environment, kanthord } from "./cli-test-support.ts";
import { gatewayFixture } from "./test-support.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
const EMPTY_OUTPUT = "";
const NAME = "e2e-model-check";
const SECRET_VALUE = "e2e-model-check-secret-never-print-this";
const MODEL = "scripted-model";
const FIRST_CALL = 0;
const TWO_CALLS = 2;
const NO_CALLS = 0;
const READ_REFUSAL =
  /^[^\n]*: request failed\nstatus: +\d{3}\n(details: +[^\n]*\n)?$/;

const okScript = (): FauxResponseStep[] => [
  fauxAssistantMessage([fauxToolCall("check_tool", {})], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("done"),
];

async function setup(t: TestContext, script: FauxResponseStep[]) {
  const scripted = scriptedModelRuntime(await loadPi(), script);
  const fixture = await gatewayFixture(t, {
    loadModelRuntime: async () => scripted.module,
  });
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const file = join(directory, "create.json");
  writePrivate(
    file,
    JSON.stringify({
      name: NAME,
      platform: "anthropic",
      metadata: null,
      secret: { key: SECRET_VALUE },
    }),
  );
  const created = await kanthord(
    ["llm", "credential", "create", "--file", file],
    env,
  );
  assert.equal(created.code, ExitCode.Success, created.stderr);
  return { fixture, env, calls: scripted.calls };
}

const checkArguments = (model: string, effort: string) => [
  "llm",
  "model",
  "check",
  "--credential",
  NAME,
  "--model",
  model,
  "--reasoning-effort",
  effort,
];

test("the CLI model check answers ok after one tool round trip", async (t) => {
  const { env, calls } = await setup(t, okScript());
  const result = await kanthord(checkArguments(MODEL, "low"), env);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
  assert.deepEqual(JSON.parse(result.stdout), { result: "ok", message: null });
  assert.ok(!result.stdout.includes(SECRET_VALUE));
  assert.equal(calls.length, TWO_CALLS);
  assert.equal(calls[FIRST_CALL]!.options?.apiKey, SECRET_VALUE);
});

test("the CLI model check answers the failure code and a redacted message", async (t) => {
  const { env } = await setup(t, [
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: `429 Rate limit exceeded for ${SECRET_VALUE}`,
    }),
  ]);
  const result = await kanthord(checkArguments(MODEL, "low"), env);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const answer = JSON.parse(result.stdout);
  assert.equal(answer.result, ModelCheckResult.RateLimited);
  assert.ok(!result.stdout.includes(SECRET_VALUE));
});

test("the CLI model check refuses an unknown model and an unsupported reasoning effort", async (t) => {
  const { env, calls } = await setup(t, okScript());
  const unknown = await kanthord(checkArguments("missing", "low"), env);
  assert.equal(unknown.code, ExitCode.Failure);
  assert.ok(unknown.stderr.startsWith("llm.model.model_unknown:"));
  assert.equal(unknown.stdout, EMPTY_OUTPUT);
  const unsupported = await kanthord(checkArguments(MODEL, "unknown"), env);
  assert.equal(unsupported.code, ExitCode.Failure);
  assert.ok(unsupported.stderr.startsWith("llm.model.reasoning_unsupported:"));
  assert.equal(calls.length, NO_CALLS);
});

test("the CLI model check refuses an unknown credential", async (t) => {
  const { env } = await setup(t, okScript());
  const result = await kanthord(
    checkArguments(MODEL, "low").map((value) =>
      value === NAME ? "missing" : value,
    ),
    env,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(result.stderr.startsWith("llm.model.credential_not_found:"));
  assert.match(result.stderr, READ_REFUSAL);
});

test("the HTTP model check validates its body and answers under human access only", async (t) => {
  const { fixture } = await setup(t, okScript());
  const post = (body: unknown, token?: string) =>
    fixture.request("/api/llm/model/check", {
      method: HttpMethod.Post,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const body = {
    credential: NAME,
    model_identifier: MODEL,
    reasoning_effort: "low",
  };
  assert.equal((await post(body)).status, HttpStatus.Unauthorized);
  const invalid = await post({ credential: NAME }, fixture.token);
  assert.equal(invalid.status, HttpStatus.BadRequest);
  const answered = await post(body, fixture.token);
  assert.equal(answered.status, HttpStatus.OK);
  assert.deepEqual(await answered.json(), { result: "ok", message: null });
});
