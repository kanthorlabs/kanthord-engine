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
} from "./test-support.ts";
import {
  emptyInput,
  OperationRegistry,
  StoreName,
  OperationLifetime,
} from "../../kernel/operation.ts";
import { isMachineIdentity } from "../../kernel/caller.ts";
import { directClient, createInvocation } from "../../gateway/index.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { workerOperations } from "../../worker/contract.ts";
import { Store, IN_MEMORY_DATABASE } from "../../kernel/store.ts";

const NO_REGISTRATIONS = 0;
const SINGLE_REGISTRATION = 1;
const TWO_CLIENTS = 2;
const DISPLAY_NAME = "test worker";
const input = { params: {}, query: {}, body: null };
const ErrorCode = {
  Unauthorized: "gateway.authentication.unauthorized",
  Capacity: "worker.instance.slot_unavailable",
  Stale: "gateway.registration.stale",
  Required: "gateway.registration.required",
} as const;
const machineRead = {
  id: "test.machine",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: HttpMethod.Get,
  path: "/api/worker/identity",
  access: AccessPolicy.Client,
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.strictObject({
    projectId: z.string(),
    resourceIdentity: z.string(),
    name: z.string(),
    runtimeIdentity: z.string(),
  }),
  status: HttpStatus.OK,
  description: "Test the machine forwarding contract.",
} as const;

test("machine fake keeps attribution after a registration ends and a replacement registers", (t) => {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  const { worker } = fakeMachines();
  const client = {
    clientId: "client",
    name: DISPLAY_NAME,
    projectId: TEST_PROJECT_ID,
    resourceIdentity: `worker:kanthord:${TEST_WORKER_BINDING}`,
  };
  store.transaction((tx) => {
    const row = worker.register(tx, client, Date.now());
    assert.deepEqual(worker.liveRegistrationOf(tx, row.runtimeIdentity), row);
    worker.deregister(tx, row.runtimeIdentity, Date.now());
    const next = worker.register(
      tx,
      { ...client, name: "replacement" },
      Date.now(),
    );
    assert.equal(worker.liveRegistrationOf(tx, row.runtimeIdentity), null);
    assert.deepEqual(worker.liveRegistrationOf(tx, next.runtimeIdentity), next);
    assert.deepEqual(worker.clientAttributionOf(tx, row.runtimeIdentity), {
      clientId: client.clientId,
      name: DISPLAY_NAME,
    });
    assert.deepEqual(worker.clientAttributionOf(tx, next.runtimeIdentity), {
      clientId: client.clientId,
      name: "replacement",
    });
    assert.equal(worker.liveRegistrationOf(tx, "unknown"), null);
    assert.equal(worker.clientAttributionOf(tx, "unknown"), null);
  });
});

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
      resourceIdentity: caller.identity.resourceIdentity,
      name: caller.identity.name,
      runtimeIdentity: caller.identity.runtimeIdentity,
    };
  });
  const fixture = await gatewayFixture(t, { registry, machines });
  const token = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
    DISPLAY_NAME,
  );
  const client = httpClient(workerOperations, fixture.endpoint, token);
  assert.equal(machines.worker.registrations.size, NO_REGISTRATIONS);
  assert.equal(decode(token).payload.name, DISPLAY_NAME);
  return { ...fixture, machines, machineJWT: token, client };
}

test("deregistration replays after ending while fresh keys refuse ended targets", async (t) => {
  const f = await fixtureForRegistration(t);
  const registered = await f.client.register(input);
  assert.ok(registered.type === OperationResultType.Completed);
  const target = { ...input, params: registered.data };
  const key = ulid();
  const ended = await f.client["instance.deregister"](target, {
    idempotencyKey: key,
  });
  assert.ok(ended.type === OperationResultType.Completed);
  assert.deepEqual(ended.data, { ...registered.data, registered: false });
  assert.deepEqual(
    await f.client["instance.deregister"](target, { idempotencyKey: key }),
    ended,
  );
  assertFailure(
    await f.client["instance.deregister"](target),
    HttpStatus.NotFound,
    "worker.instance.not_found",
  );
  const next = await f.client.register(input);
  assert.ok(next.type === OperationResultType.Completed);
  assert.notEqual(next.data.runtimeIdentity, registered.data.runtimeIdentity);
  assertFailure(
    await f.client["instance.deregister"](target),
    HttpStatus.NotFound,
    "worker.instance.not_found",
  );
  assert.equal(f.machines.worker.registrations.size, SINGLE_REGISTRATION);
});

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
    await fixture.machineToken(TEST_PROJECT_ID, "absent"),
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
  assert.equal(fixture.gateway.invocation.idempotency.healthcheck(), true);
});

test("heartbeat answers empty HTTP 204 and direct null only for registered machine identities", async (t) => {
  const fixture = await fixtureForRegistration(t);
  assertFailure(
    await fixture.client.heartbeat(input),
    HttpStatus.Forbidden,
    ErrorCode.Required,
  );
  const registered = await fixture.client.register(input);
  assert.ok(registered.type === OperationResultType.Completed);
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  const direct = await directClient(
    workerOperations,
    fixture.gateway.invocation,
  ).heartbeat(input, { identity });
  assert.ok(direct.type === OperationResultType.Completed);
  assert.equal(direct.data, null);
  const http = await fixture.client.heartbeat(input);
  assert.deepEqual(http, direct);
  const raw = await fixture.request(workerOperations.heartbeat.path, {
    method: "POST",
    headers: { Authorization: `Bearer ${fixture.machineJWT}` },
  });
  assert.equal(raw.status, HttpStatus.NoContent);
  const empty = "";
  assert.equal(await raw.text(), empty);
  assertFailure(
    await httpClient(
      workerOperations,
      fixture.endpoint,
      fixture.token,
    ).heartbeat(input),
    HttpStatus.Unauthorized,
    ErrorCode.Unauthorized,
  );
  const body = await fixture.request(workerOperations.heartbeat.path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.machineJWT}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(body.status, HttpStatus.BadRequest);
  const unexpected = "gateway.request.unexpected_body";
  assert.equal(errorSchema.parse(await body.json()).error.code, unexpected);
});

test("concurrent machine registrations cannot oversubscribe one binding", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const otherToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
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
    /^worker_instance_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  );
  const retry = await fixture.client.register(input);
  assert.ok(retry.type === OperationResultType.Completed);
  assert.deepEqual(retry.data, first.data);
  const identity = await fixture.gateway.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  const direct = directClient(workerOperations, fixture.gateway.invocation);
  assert.deepEqual(
    await direct.register(input, { idempotencyKey: key, identity }),
    first,
  );
  assert.deepEqual(
    await fixture.client.register(input, { idempotencyKey: key }),
    first,
  );
  assert.equal(fixture.machines.worker.registrations.size, SINGLE_REGISTRATION);
  fixture.machines.worker.restart();
  assertFailure(
    await fixture.client.register(input, { idempotencyKey: key }),
    HttpStatus.Conflict,
    ErrorCode.Stale,
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

test("a new invocation loses replay but registration retains its natural-key identity", async (t) => {
  const fixture = await fixtureForRegistration(t);
  const idempotencyKey = ulid();
  const first = await fixture.client.register(input, { idempotencyKey });
  assert.ok(first.type === OperationResultType.Completed);
  const invocation = createInvocation({
    registry: fixture.gateway.registry,
    stores: { [StoreName.Operational]: fixture.store },
    masterKey: fixture.config.masterKey,
    tokenLifetime: fixture.config.gateway.tokenLifetime,
    lookups: fixture.machines,
  });
  t.after(() => invocation.stop());
  const reserve = t.mock.method(invocation.idempotency, "reserve");
  const identity = await invocation.authentication.authenticate(
    `Bearer ${fixture.machineJWT}`,
  );
  const next = await directClient(workerOperations, invocation).register(
    input,
    { identity, idempotencyKey },
  );
  assert.deepEqual(next, first);
  assert.equal(reserve.mock.calls.length, SINGLE_REGISTRATION);
  assert.equal(reserve.mock.calls[0]!.result!.replay, undefined);
  assert.equal(fixture.machines.worker.registrations.size, SINGLE_REGISTRATION);
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
    resourceIdentity: `worker:kanthord:${TEST_WORKER_BINDING}`,
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
  fixture.store.transaction((tx) =>
    fixture.machines.worker.deregister(
      tx,
      registered.data.runtimeIdentity,
      Date.now(),
    ),
  );
  assertFailure(
    await client.read(input),
    HttpStatus.Forbidden,
    ErrorCode.Required,
  );
});

test("direct machine identities recheck binding availability and registration before input validation", async (t) => {
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
    const token = await fixture.machineToken(
      TEST_PROJECT_ID,
      TEST_WORKER_BINDING,
    );
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
  assert.equal(fixture.gateway.invocation.idempotency.healthcheck(), true);
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
  assert.ok(!JSON.stringify(replay).includes("sensitive-test-output"));
});
