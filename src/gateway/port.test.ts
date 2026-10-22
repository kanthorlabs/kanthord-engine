import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import pino from "pino";
import { MASTER_KEY_BYTES } from "../config/global.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  OperationLifetime,
  OperationRegistry,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { intakeOperations } from "../intake/contract.ts";
import { workerOperations } from "../worker/contract.ts";
import type { PortAnswer } from "./client.ts";
import type { RecordedResponse } from "./idempotency.ts";
import { createInvocation, gatewayMigrations, servePort } from "./index.ts";
import type { Invocation, InvocationOptions } from "./invocation.ts";

const TOKEN = "port-test-token";
const IDEMPOTENCY_KEY = "key-1";
const AUTH_VERSION = 1;
const SINGLE_ANSWER = 1;
const NO_CALLS = 0;
const POLL_INTERVAL_MS = 5;
const OVERSIZED_BODY_PADDING = 1;
const VALIDATION_FAILED = "gateway.request.validation_failed";
const NOT_FOUND = "gateway.routing.not_found";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const BODY_TOO_LARGE = "gateway.request.body_too_large";
const INVALID_JSON = "gateway.request.invalid_json";
const UNKNOWN_FAILURE = "gateway.invocation.unknown";
const FAILED_MESSAGE = "Request failed";

interface Recorded {
  id: string;
  options: InvocationOptions;
}

function fakeInvocation(
  respond: (options: InvocationOptions) => Promise<RecordedResponse> = () =>
    Promise.resolve({ status: HttpStatus.OK, body: {} }),
) {
  const calls: Recorded[] = [];
  const invocation = {
    invoke: (id: string, _input: unknown, options: InvocationOptions) => {
      calls.push({ id, options });
      return respond(options);
    },
  } as unknown as Invocation;
  return { invocation, calls };
}

function connect(
  t: TestContext,
  invocation: Invocation,
  credential: () => string = () => TOKEN,
) {
  const { port1, port2 } = new MessageChannel();
  servePort(port1, invocation, credential, pino({ level: "silent" }));
  const answers: PortAnswer[] = [];
  port2.on("message", (answer: PortAnswer) => answers.push(answer));
  t.after(() => {
    port1.close();
    port2.close();
  });
  return { port: port2, answers };
}

async function eventually<T>(
  read: () => T | undefined,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    await delay(POLL_INTERVAL_MS, undefined, { signal });
  }
}

function answerOf(answers: PortAnswer[], callId: string, signal: AbortSignal) {
  return eventually(
    () => answers.find((entry) => entry.call_id === callId),
    signal,
  );
}

function callOf(operation: Operation, callId: string, body: string | null) {
  return {
    call_id: callId,
    operation_id: operation.id,
    params: {},
    query: {},
    body,
  };
}

function errorCode(answer: PortAnswer): unknown {
  return (answer.body as { error: { code: string } }).error.code;
}

function realInvocation(t: TestContext): Invocation {
  const registry = new OperationRegistry();
  registry.register(workerOperations.handover, () =>
    assert.fail("The handler is unreachable."),
  );
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    authVersion: AUTH_VERSION,
  });
  t.after(() => invocation.stop());
  return invocation;
}

test("a port call passes the authorization and never an identity", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage({
    ...callOf(workerOperations.heartbeat, "call-1", null),
    idempotency_key: IDEMPOTENCY_KEY,
  });
  const answer = await answerOf(answers, "call-1", t.signal);
  assert.equal(answer.status, HttpStatus.OK);
  assert.equal(calls.length, SINGLE_ANSWER);
  const [call] = calls;
  assert.equal(call?.id, workerOperations.heartbeat.id);
  assert.equal(call?.options.authorization, `Bearer ${TOKEN}`);
  assert.equal(call?.options.idempotencyKey, IDEMPOTENCY_KEY);
  assert.ok(call?.options.requestId);
  assert.ok(!("identity" in (call?.options ?? {})));
});

test("a port close cancels the pending calls", async (t) => {
  const { invocation, calls } = fakeInvocation(
    (options) =>
      new Promise((resolve) => {
        if (options.context)
          addAbortListener(options.context.signal, () =>
            resolve({ status: HttpStatus.OK, body: {} }),
          );
      }),
  );
  const { port } = connect(t, invocation);
  port.postMessage(callOf(workerOperations.heartbeat, "call-1", null));
  const call = await eventually(() => calls[0], t.signal);
  assert.ok(!call.options.context?.signal.aborted);
  port.close();
  await eventually(() => call.options.context?.signal.reason, t.signal);
});

test("a malformed message with a readable call id is answered with a validation failure", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage({ call_id: "call-1", operation_id: 1 });
  const answer = await answerOf(answers, "call-1", t.signal);
  assert.equal(answer.status, HttpStatus.BadRequest);
  assert.equal(errorCode(answer), VALIDATION_FAILED);
  assert.equal(calls.length, NO_CALLS);
});

test("a malformed message without a call id is dropped", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage({ operation_id: workerOperations.heartbeat.id });
  port.postMessage(null);
  port.postMessage("text");
  port.postMessage({ call_id: 1 });
  port.postMessage(callOf(workerOperations.heartbeat, "call-1", null));
  await answerOf(answers, "call-1", t.signal);
  assert.equal(answers.length, SINGLE_ANSWER);
  assert.equal(calls.length, SINGLE_ANSWER);
});

test("a stream operation is answered as an absent route", async (t) => {
  t.mock.property(
    workerOperations.heartbeat as Operation,
    "lifetime",
    OperationLifetime.Stream,
  );
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage(callOf(workerOperations.heartbeat, "call-1", null));
  const answer = await answerOf(answers, "call-1", t.signal);
  assert.equal(answer.status, HttpStatus.NotFound);
  assert.equal(errorCode(answer), NOT_FOUND);
  assert.equal(calls.length, NO_CALLS);
});

test("an operation id outside the five operation maps is answered as an absent route", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage(callOf(intakeOperations["action.perform"], "call-1", "{}"));
  port.postMessage({
    ...callOf(workerOperations.heartbeat, "call-2", null),
    operation_id: "worker.unknown",
  });
  for (const callId of ["call-1", "call-2"]) {
    const answer = await answerOf(answers, callId, t.signal);
    assert.equal(answer.status, HttpStatus.NotFound, callId);
    assert.equal(errorCode(answer), NOT_FOUND, callId);
  }
  assert.equal(calls.length, NO_CALLS);
});

test("a body that fails to parse reaches the invocation as a rejection", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  port.postMessage(callOf(workerOperations.handover, "call-1", "not json"));
  await answerOf(answers, "call-1", t.signal);
  assert.equal(calls.length, SINGLE_ANSWER);
  assert.equal(calls[0]?.options.rejection?.code, INVALID_JSON);
});

test("a body above the limit is refused before the invocation", async (t) => {
  const { invocation, calls } = fakeInvocation();
  const { port, answers } = connect(t, invocation);
  const body = "x".repeat(
    (workerOperations.handover.maxBodyBytes ?? NO_CALLS) +
      OVERSIZED_BODY_PADDING,
  );
  port.postMessage(callOf(workerOperations.handover, "call-1", body));
  const answer = await answerOf(answers, "call-1", t.signal);
  assert.equal(answer.status, HttpStatus.PayloadTooLarge);
  assert.equal(errorCode(answer), BODY_TOO_LARGE);
  assert.equal(calls.length, NO_CALLS);
});

test("an authentication failure wins over a body failure and a body above the limit wins over authentication", async (t) => {
  const { port, answers } = connect(t, realInvocation(t), () => "not-a-jwt");
  port.postMessage(callOf(workerOperations.handover, "call-1", "not json"));
  const oversized = "x".repeat(
    (workerOperations.handover.maxBodyBytes ?? NO_CALLS) +
      OVERSIZED_BODY_PADDING,
  );
  port.postMessage(callOf(workerOperations.handover, "call-2", oversized));
  const authentication = await answerOf(answers, "call-1", t.signal);
  assert.equal(authentication.status, HttpStatus.Unauthorized);
  assert.equal(errorCode(authentication), UNAUTHORIZED);
  const size = await answerOf(answers, "call-2", t.signal);
  assert.equal(size.status, HttpStatus.PayloadTooLarge);
  assert.equal(errorCode(size), BODY_TOO_LARGE);
});

test("a port call passes its logger and logs an unknown failure at the error level", async (t) => {
  const failure = new Error("invocation bug");
  const { invocation, calls } = fakeInvocation(() => Promise.reject(failure));
  const records: Record<string, unknown>[] = [];
  const { port1, port2 } = new MessageChannel();
  servePort(
    port1,
    invocation,
    () => TOKEN,
    pino(
      { level: "info" },
      { write: (line) => records.push(JSON.parse(line)) },
    ),
  );
  const answers: PortAnswer[] = [];
  port2.on("message", (answer: PortAnswer) => answers.push(answer));
  t.after(() => {
    port1.close();
    port2.close();
  });
  port2.postMessage(callOf(workerOperations.heartbeat, "call-1", null));
  const answer = await answerOf(answers, "call-1", t.signal);
  assert.equal(answer.status, HttpStatus.InternalServerError);
  assert.equal(errorCode(answer), UNKNOWN_FAILURE);
  assert.ok(calls[0]?.options.logger);
  const failed = records.filter((record) => record.msg === FAILED_MESSAGE);
  assert.equal(failed.length, SINGLE_ANSWER);
  assert.equal(failed[0]!.level, pino.levels.values.error);
  assert.equal(failed[0]!.request_id, calls[0]!.options.requestId);
  assert.equal(
    (failed[0]!.err as { message: string }).message,
    failure.message,
  );
});
