import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { ulid } from "ulid";
import { decode } from "hono/jwt";
import {
  fakeMachines,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "../test-support.ts";
import { emptyInput, OperationRegistry } from "./registry.ts";
import { isMachineIdentity } from "./authentication.ts";
import { directClient, httpClient, OperationResultType } from "./client.ts";
import { AccessPolicy } from "./constants.ts";
import { HttpMethod, HttpStatus } from "../shared/http.ts";
import { errorSchema } from "./errors.ts";
import { workerOperations } from "../worker/operations.ts";

const NO_REGISTRATIONS = 0;
const SINGLE_REGISTRATION = 1;
const TWO_CLIENTS = 2;
const DISPLAY_NAME = "test worker";
const input = { params: {}, query: {}, body: null };
const ErrorCode = {
  Unauthorized: "gateway.authentication.unauthorized",
  Conflict: "gateway.registration.conflict",
  Capacity: "gateway.registration.capacity",
  Stale: "gateway.registration.stale",
  Required: "gateway.registration.required",
} as const;
const machineRead = {
  id: "test.machine",
  service: "test",
  method: HttpMethod.Get,
  path: "/api/worker/identity",
  access: AccessPolicy.Client,
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.strictObject({
    projectId: z.string(),
    workerBindingId: z.string(),
    name: z.string(),
    runtimeIdentity: z.string(),
  }),
  status: HttpStatus.OK,
  description: "Test the machine forwarding contract.",
} as const;

async function fixtureForRegistration(
  t: TestContext,
  capacity = SINGLE_REGISTRATION,
) {
  const machines = fakeMachines({
    bindings: new Map([
      [
        TEST_WORKER_BINDING,
        { projectId: TEST_PROJECT_ID, capacity, available: true },
      ],
    ]),
  });
  const registry = new OperationRegistry();
  registry.register(machineRead, (_input, caller) => {
    assert.ok(isMachineIdentity(caller.identity));
    assert.ok(Object.isFrozen(caller.identity));
    assert.ok(caller.identity.runtimeIdentity);
    return {
      projectId: caller.identity.projectId,
      workerBindingId: caller.identity.workerBindingId,
      name: caller.identity.name,
      runtimeIdentity: caller.identity.runtimeIdentity,
    };
  });
  const fixture = await gatewayFixture(t, { registry, machines });
  const token = await fixture.machineToken(TEST_WORKER_BINDING, DISPLAY_NAME);
  const client = httpClient(workerOperations, fixture.endpoint, token);
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
  assert.equal(decode(token).payload.name, DISPLAY_NAME);
  return { ...fixture, machines, machineJWT: token, client };
}

function assertFailure(
  result: { type: string; status?: number; error?: unknown },
  status: number,
  code: string,
) {
  assert.equal(result.type, OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(errorSchema.parse(result.error).error.code, code);
}

test("absent, removed and unavailable worker bindings refuse registration before reserving a key", async (t) => {
  const fixture = await fixtureForRegistration(t);
  for (const token of [
    await fixture.machineToken("absent"),
    fixture.machineJWT,
  ]) {
    fixture.machines.project.bindings.get(TEST_WORKER_BINDING)!.available =
      false;
    const result = await httpClient(
      workerOperations,
      fixture.endpoint,
      token,
    ).register(input);
    assertFailure(result, HttpStatus.Unauthorized, ErrorCode.Unauthorized);
    assert.equal(fixture.machines.worker.registrations.size, NO_REGISTRATIONS);
  }
  fixture.machines.project.bindings.delete(TEST_WORKER_BINDING);
  assertFailure(
    await fixture.client.register(input),
    HttpStatus.Unauthorized,
    ErrorCode.Unauthorized,
  );
  assert.deepEqual(
    fixture.store.database.prepare("SELECT * FROM gateway_idempotency").all(),
    [],
  );
});

test("concurrent machine registrations cannot oversubscribe one binding", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const otherToken = await fixture.machineToken(TEST_WORKER_BINDING);
  const other = httpClient(workerOperations, fixture.endpoint, otherToken);
  const results = await Promise.all([
    fixture.client.register(input),
    other.register(input),
  ]);
  assert.equal(
    results.filter((result) => result.type === OperationResultType.Completed)
      .length,
    SINGLE_REGISTRATION,
  );
  const refusal = results.find(
    (result) => result.type === OperationResultType.Failure,
  )!;
  assertFailure(refusal, HttpStatus.Conflict, ErrorCode.Capacity);
  assert.equal(fixture.machines.worker.registrations.size, SINGLE_REGISTRATION);
});

test("one live registration per client, live replay across adapters, and stale replay without rewriting the record", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const key = ulid();
  const first = await fixture.client.register(input, { idempotencyKey: key });
  assert.equal(first.type, OperationResultType.Completed);
  assert.ok(first.type === OperationResultType.Completed);
  assert.match(
    first.data.runtimeIdentity,
    /^runtime_identity_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  );
  assertFailure(
    await fixture.client.register(input),
    HttpStatus.Conflict,
    ErrorCode.Conflict,
  );
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  const direct = directClient(workerOperations, fixture.gateway.invocation, {
    identity,
  });
  assert.deepEqual(
    await direct.register(input, { idempotencyKey: key }),
    first,
  );
  assert.deepEqual(
    await fixture.client.register(input, { idempotencyKey: key }),
    first,
  );
  assert.equal(fixture.machines.worker.registrations.size, SINGLE_REGISTRATION);
  const recorded = fixture.store.database
    .prepare("SELECT * FROM gateway_idempotency WHERE key = ?")
    .get(key);
  fixture.machines.worker.restart();
  assertFailure(
    await fixture.client.register(input, { idempotencyKey: key }),
    HttpStatus.Conflict,
    ErrorCode.Stale,
  );
  assert.deepEqual(
    fixture.store.database
      .prepare("SELECT * FROM gateway_idempotency WHERE key = ?")
      .get(key),
    recorded,
  );
  const next = await fixture.client.register(input);
  assert.ok(next.type === OperationResultType.Completed);
  assert.notEqual(next.data.runtimeIdentity, first.data.runtimeIdentity);
  assertFailure(
    await fixture.client.register(input, { idempotencyKey: key }),
    HttpStatus.Conflict,
    ErrorCode.Stale,
  );
});

test("work requires a live registration and machine JWTs never authorize human verification", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const client = httpClient(
    { read: machineRead },
    fixture.endpoint,
    fixture.machineJWT,
  );
  assertFailure(
    await client.read(input),
    HttpStatus.Forbidden,
    ErrorCode.Required,
  );
  const registered = await fixture.client.register(input);
  assert.ok(registered.type === OperationResultType.Completed);
  const response = await client.read(input);
  assert.ok(response.type === OperationResultType.Completed);
  assert.deepEqual(response.data, {
    projectId: TEST_PROJECT_ID,
    workerBindingId: TEST_WORKER_BINDING,
    name: DISPLAY_NAME,
    runtimeIdentity: registered.data.runtimeIdentity,
  });
  const human = await fixture.request("/api/auth/verify", {
    headers: { Authorization: `Bearer ${fixture.machineJWT}` },
  });
  assert.equal(human.status, HttpStatus.Unauthorized);
  assertFailure(
    await httpClient(
      { read: machineRead },
      fixture.endpoint,
      fixture.token,
    ).read(input),
    HttpStatus.Unauthorized,
    ErrorCode.Unauthorized,
  );
  fixture.machines.worker.deregister(registered.data.runtimeIdentity);
  assertFailure(
    await client.read(input),
    HttpStatus.Forbidden,
    ErrorCode.Required,
  );
});

test("direct machine identities recheck bans, binding availability and registration before input validation", async (t) => {
  const fixture = await fixtureForRegistration(t);
  assert.ok(
    (await fixture.client.register(input)).type ===
      OperationResultType.Completed,
  );
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  assert.ok(isMachineIdentity(identity));
  const invoke = () =>
    fixture.gateway.invocation.invoke(
      machineRead.id,
      { invalid: true },
      { identity },
    );
  const binding = fixture.machines.project.bindings.get(TEST_WORKER_BINDING)!;
  binding.available = false;
  assert.equal((await invoke()).status, HttpStatus.Unauthorized);
  binding.available = true;
  fixture.machines.worker.restart();
  assert.equal((await invoke()).status, HttpStatus.Unauthorized);
  fixture.gateway.authentication.ban(identity.jti, Date.now() + 60000);
  assert.equal((await invoke()).status, HttpStatus.Unauthorized);
  assert.equal(fixture.machines.worker.registrations.size, NO_REGISTRATIONS);
});

test("another client using the same key registers and runs its own mutation instead of receiving cached answers", async (t) => {
  const machines = fakeMachines({
    bindings: new Map([
      [
        TEST_WORKER_BINDING,
        { projectId: TEST_PROJECT_ID, capacity: TWO_CLIENTS },
      ],
    ]),
  });
  const registry = new OperationRegistry();
  const operation = {
    ...machineRead,
    id: "test.write",
    path: "/api/write",
    method: HttpMethod.Post,
    mutation: true,
    output: z.strictObject({ caller: z.string(), count: z.int() }),
  } as const;
  let calls = 0;
  registry.register(operation, (_input, caller) =>
    caller.commit(() => {
      assert.ok(isMachineIdentity(caller.identity));
      assert.ok(caller.identity.runtimeIdentity);
      return { caller: caller.identity.clientId, count: ++calls };
    }),
  );
  const fixture = await gatewayFixture(t, { registry, machines });
  const registrationKey = ulid();
  const mutationKey = ulid();
  for (let index = 0; index < TWO_CLIENTS; index++) {
    const token = await fixture.machineToken(TEST_WORKER_BINDING);
    const worker = httpClient(workerOperations, fixture.endpoint, token);
    assert.ok(
      (await worker.register(input, { idempotencyKey: registrationKey }))
        .type === OperationResultType.Completed,
    );
    const client = httpClient({ operation }, fixture.endpoint, token);
    const result = await client.operation(input, {
      idempotencyKey: mutationKey,
    });
    assert.ok(result.type === OperationResultType.Completed);
    assert.equal(result.data.caller, decode(token).payload.sub);
    assert.deepEqual(
      await client.operation(input, { idempotencyKey: mutationKey }),
      result,
    );
  }
  assert.equal(calls, TWO_CLIENTS);
  assert.equal(machines.worker.registrations.size, TWO_CLIENTS);
});

test("a registration is deregistered when recording its atomic response fails", async (t) => {
  const fixture = await fixtureForRegistration(t);
  fixture.store.database.exec(`
    CREATE TRIGGER reject_registration_answer BEFORE UPDATE ON gateway_idempotency
    WHEN json_extract(NEW.response, '$.status') = 200
    BEGIN SELECT RAISE(ABORT, 'test response persistence failure'); END;
  `);
  const result = await fixture.client.register(input);
  assert.equal(result.type, OperationResultType.Failure);
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, HttpStatus.InternalServerError);
  assert.equal(fixture.machines.worker.registrations.size, NO_REGISTRATIONS);
  fixture.store.database.exec("DROP TRIGGER reject_registration_answer");
  assert.ok(
    (await fixture.client.register(input)).type ===
      OperationResultType.Completed,
  );
  assert.equal(fixture.machines.worker.registrations.size, SINGLE_REGISTRATION);
});

test("an invalid accepted registration is cleaned up before returning a failure", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const register = fixture.machines.worker.register;
  t.mock.method(
    fixture.machines.worker,
    "register",
    (...args: Parameters<typeof register>) => ({
      ...register(...args),
      projectId: "another-project",
    }),
  );
  const result = await fixture.client.register(input);
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, HttpStatus.InternalServerError);
  assert.equal(fixture.machines.worker.registrations.size, NO_REGISTRATIONS);
});

test("registration accepts only a bearer machine JWT, no nominated identity or body", async (t) => {
  const fixture = await fixtureForRegistration(t);
  for (const token of [undefined, fixture.token]) {
    const response = await httpClient(
      workerOperations,
      fixture.endpoint,
      token,
    ).register(input);
    assertFailure(response, HttpStatus.Unauthorized, ErrorCode.Unauthorized);
  }
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  const forged = await fixture.gateway.invocation.invoke(
    workerOperations.register.id,
    input,
    { identity: { ...identity }, idempotencyKey: ulid() },
  );
  assert.equal(forged.status, HttpStatus.Unauthorized);
  const headers = {
    Authorization: `Bearer ${fixture.machineJWT}`,
    "Content-Type": "application/json",
    "Idempotency-Key": ulid(),
  };
  for (const body of ["{}", JSON.stringify({ binding: TEST_WORKER_BINDING })]) {
    const response = await fixture.request(workerOperations.register.path, {
      method: HttpMethod.Post,
      headers,
      body,
    });
    assert.equal(response.status, HttpStatus.BadRequest);
  }
  assert.equal(fixture.machines.worker.registrations.size, NO_REGISTRATIONS);
  assert.deepEqual(
    fixture.store.database.prepare("SELECT * FROM gateway_idempotency").all(),
    [],
  );
});

test("an operation returning a secret never reruns a repeated idempotency key", async (t) => {
  const registry = new OperationRegistry();
  const operation = {
    ...machineRead,
    id: "test.sensitive",
    path: "/api/sensitive",
    access: AccessPolicy.Human,
    method: HttpMethod.Post,
    mutation: true,
    secret: true,
    output: z.strictObject({ value: z.string() }),
  } as const;
  let calls = 0;
  registry.register(operation, (_input, caller) =>
    caller.commit(() => {
      calls++;
      return { value: "sensitive-test-output" };
    }),
  );
  const fixture = await gatewayFixture(t, { registry });
  const client = httpClient({ operation }, fixture.endpoint, fixture.token);
  const idempotencyKey = ulid();
  assert.ok(
    (await client.operation(input, { idempotencyKey })).type ===
      OperationResultType.Completed,
  );
  const replay = await client.operation(input, { idempotencyKey });
  assert.ok(replay.type === OperationResultType.Failure);
  assert.equal(replay.status, HttpStatus.Conflict);
  assert.equal(calls, SINGLE_REGISTRATION);
  assert.ok(
    !JSON.stringify(
      fixture.store.database.prepare("SELECT * FROM gateway_idempotency").all(),
    ).includes("sensitive-test-output"),
  );
});
