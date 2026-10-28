import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { Logger } from "pino";
import { z } from "zod";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { MASTER_KEY_BYTES } from "../config/global.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  OperationRegistry,
  StoreName,
} from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import { createInvocation, gatewayMigrations } from "./index.ts";
import { generateHumanJWT, generateMachineJWT } from "./auth/jwt.ts";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import type { ExecutionProofRow } from "../kernel/operation.ts";

const AUTH_VERSION = 1;

const operation = {
  id: "test.commit.read",
  service: "test",
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  method: "GET",
  path: "/api/test/commit",
  access: AccessPolicy.Human,
  timeoutMs: 30000,
  mutation: false,
  input: emptyInput,
  output: z.number(),
  status: HttpStatus.OK,
  description: "Read a value inside a transaction.",
} as const;
const input = { params: {}, query: {}, body: null };
const COMMITTED_VALUE = 42;
const EXECUTION_PROOF_FAILED = "gateway.invocation.execution_proof_failed";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const VALIDATION_FAILED = "gateway.request.validation_failed";

async function fixture(t: TestContext, registry: OperationRegistry) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    authVersion: AUTH_VERSION,
  });
  t.after(() => invocation.stop());
  const { token } = await generateHumanJWT(masterKey, AUTH_VERSION, 600);
  return { invocation, token };
}

test("read operation commits once", async (t) => {
  const registry = new OperationRegistry();
  registry.register(operation, (_input, caller) =>
    caller.commit(({ database }) =>
      Number(database.prepare("SELECT 42 AS value").get()?.value),
    ),
  );
  const { invocation, token } = await fixture(t, registry);
  const response = await invocation.invoke(operation.id, input, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(response.body, COMMITTED_VALUE);
});

test("second commit throws", async (t) => {
  const registry = new OperationRegistry();
  let secondError: unknown;
  registry.register(operation, (_input, caller) => {
    caller.commit(() => 42);
    try {
      caller.commit(() => 43);
    } catch (error) {
      secondError = error;
    }
    return 42;
  });
  const { invocation, token } = await fixture(t, registry);
  await invocation.invoke(operation.id, input, {
    authorization: `Bearer ${token}`,
  });
  assert.ok(secondError instanceof Error);
  assert.match(secondError.message, /called twice/);
});

test("execution proof precedes reservation and replay and supplies only proven claim fields", async (t) => {
  const now = 10000;
  t.mock.method(Date, "now", () => now);
  const registry = new OperationRegistry();
  const store = new Store(":memory:");
  t.after(() => store.close());
  const row: ExecutionProofRow = {
    execution_id: createIdentity("execution"),
    project_id: createIdentity("project"),
    node_id: createIdentity("node"),
    runtime_identity: createIdentity("worker_registration"),
    worker_binding_id: createIdentity("binding"),
    attempt: 1,
    pinned_revision: 2,
    node_branch: "kanthord/node_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    expired_at: now + 100,
    ended_at: null,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.project_id,
      resourceIdentity: "worker:kanthord:general",
      issuedAt: now,
    },
    "machine",
    row.runtime_identity,
  );
  let proof: ExecutionProofRow | undefined = row;
  let registered = true;
  const protectedOperation = {
    ...operation,
    access: AccessPolicy.Client,
    mutation: true,
    requiresExecution: true,
    input: z.strictObject({
      params: z.strictObject({ execution_id: z.string().optional() }),
      query: z.strictObject({}),
      body: z.strictObject({ execution_id: z.string().optional() }),
    }),
  };
  let calls = 0;
  registry.register(protectedOperation, (_input, caller) => {
    calls++;
    const claim = {
      executionId: row.execution_id,
      projectId: row.project_id,
      nodeId: row.node_id,
      runtimeIdentity: row.runtime_identity,
      workerBindingId: row.worker_binding_id,
      attempt: row.attempt,
      pinnedRevision: row.pinned_revision,
      nodeBranch: row.node_branch,
    };
    assert.deepEqual(caller.execution, claim);
    return caller.commit(() => COMMITTED_VALUE);
  });
  registry.seal({ [StoreName.Operational]: store });
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    authVersion: AUTH_VERSION,
    lookups: {
      project: {
        resolveWorkerGroup: async () => ({
          project_id: identity.projectId,
          resource_identity: identity.resourceIdentity,
        }),
        workerGroupEnded: async () => false,
      },
      worker: {
        findByClient: () =>
          registered
            ? {
                runtime_identity: row.runtime_identity,
                registered_at: now,
                client_id: identity.clientId,
                name: identity.name,
                project_id: identity.projectId,
                resource_identity: identity.resourceIdentity,
              }
            : undefined,
        heartbeat: () => {},
      },
      scheduler: {
        executionOf: (id) => (id === row.execution_id ? proof : undefined),
      },
    },
  });
  t.after(() => invocation.stop());
  const key = createIdempotencyKey();
  const request = {
    params: { execution_id: row.execution_id },
    query: {},
    body: {},
  };
  for (const candidate of [
    undefined,
    { ...row, runtime_identity: createIdentity("worker_registration") },
    { ...row, ended_at: now },
    { ...row, expired_at: now },
  ]) {
    proof = candidate;
    const answer = await invocation.invoke(operation.id, request, {
      identity,
      idempotencyKey: key,
    });
    assert.equal(answer.status, HttpStatus.Forbidden);
    assert.equal(
      (answer.body as { error: { code: string } }).error.code,
      EXECUTION_PROOF_FAILED,
    );
  }
  const NO_CALLS = 0;
  const ONE_CALL = 1;
  assert.equal(calls, NO_CALLS);
  proof = row;
  assert.equal(
    (
      await invocation.invoke(operation.id, request, {
        identity,
        idempotencyKey: key,
      })
    ).status,
    HttpStatus.OK,
  );
  assert.equal(calls, ONE_CALL);
  proof = { ...row, ended_at: now };
  assert.equal(
    (
      await invocation.invoke(operation.id, request, {
        identity,
        idempotencyKey: key,
      })
    ).status,
    HttpStatus.Forbidden,
  );
  assert.equal(calls, ONE_CALL);
  proof = row;
  assert.equal(
    (
      await invocation.invoke(
        operation.id,
        { params: {}, query: {}, body: { execution_id: row.execution_id } },
        {
          identity,
          idempotencyKey: createIdempotencyKey(),
        },
      )
    ).status,
    HttpStatus.OK,
  );
  assert.equal(
    (
      await invocation.invoke(operation.id, request, {
        identity: testHumanIdentity("ulrich", "Ulrich", "human"),
        idempotencyKey: key,
      })
    ).status,
    HttpStatus.Unauthorized,
  );
  registered = false;
  const unregistered = testMachineIdentity(
    {
      clientId: identity.clientId,
      name: identity.name,
      projectId: identity.projectId,
      resourceIdentity: identity.resourceIdentity,
      issuedAt: now,
    },
    "unregistered",
  );
  const refusal = await invocation.invoke(operation.id, request, {
    identity: unregistered,
    idempotencyKey: key,
  });
  assert.equal(refusal.status, HttpStatus.Forbidden);
  const registrationRequired = "gateway.registration.required";
  assert.equal(
    (refusal.body as { error: { code: string } }).error.code,
    registrationRequired,
  );
});

test("authentication precedes request validation on a credentialed route", async (t) => {
  const registry = new OperationRegistry();
  const named = {
    ...operation,
    id: "test.named.create",
    method: "POST",
    path: "/api/test/named",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: z.strictObject({ name: z.string() }),
    }),
  } as const;
  registry.register(named, () => COMMITTED_VALUE);
  const { invocation, token } = await fixture(t, registry);
  const invalid = { params: {}, query: {}, body: {} };
  const codeOf = (body: unknown) =>
    (body as { error: { code: string } }).error.code;
  for (const authorization of [undefined, "Bearer garbage"]) {
    const response = await invocation.invoke(named.id, invalid, {
      authorization,
    });
    assert.equal(response.status, HttpStatus.Unauthorized);
    assert.equal(codeOf(response.body), UNAUTHORIZED);
  }
  const response = await invocation.invoke(named.id, invalid, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(response.status, HttpStatus.BadRequest);
  assert.equal(codeOf(response.body), VALIDATION_FAILED);
});

test("a validation failure names each unrecognized key", async (t) => {
  const registry = new OperationRegistry();
  const named = {
    ...operation,
    id: "test.named.create",
    method: "POST",
    path: "/api/test/named",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: z.strictObject({ name: z.string() }),
    }),
  } as const;
  registry.register(named, () => COMMITTED_VALUE);
  const { invocation, token } = await fixture(t, registry);
  const response = await invocation.invoke(
    named.id,
    { params: {}, query: {}, body: { name: "a", first: 1, second: 2 } },
    { authorization: `Bearer ${token}` },
  );
  assert.equal(response.status, HttpStatus.BadRequest);
  assert.deepEqual(
    (response.body as { error: { details: unknown } }).error.details,
    [
      { path: ["body", "first"], code: "unrecognized_keys" },
      { path: ["body", "second"], code: "unrecognized_keys" },
    ],
  );
});

function machineInvocation(
  t: TestContext,
  registry: OperationRegistry,
  resolveWorkerGroup: (context: Context) => Promise<void>,
  ended = false,
  drained: { registered: boolean } | null = null,
) {
  const store = new Store(":memory:");
  t.after(() => store.close());
  registry.seal({ [StoreName.Operational]: store });
  const heartbeats: string[] = [];
  const runtime = createIdentity("worker_registration");
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: createIdentity("project"),
      resourceIdentity: "worker:kanthord:general",
      issuedAt: Date.now(),
    },
    "machine",
    runtime,
  );
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    authVersion: AUTH_VERSION,
    lookups: {
      project: {
        resolveWorkerGroup: async (
          _projectId,
          _resource,
          _issuedAt,
          context,
        ) => {
          await resolveWorkerGroup(context);
          return ended
            ? null
            : {
                project_id: identity.projectId,
                resource_identity: identity.resourceIdentity,
                ...(drained === null ? {} : { worker_instances: [] }),
              };
        },
        workerGroupEnded: async () => ended,
      },
      worker: {
        findByClient: () =>
          drained?.registered === false
            ? undefined
            : {
                runtime_identity: runtime,
                registered_at: Date.now(),
                client_id: identity.clientId,
                name: identity.name,
                project_id: identity.projectId,
                resource_identity: identity.resourceIdentity,
              },
        heartbeat: (runtimeIdentity) => {
          heartbeats.push(runtimeIdentity);
        },
      },
    },
  });
  t.after(() => invocation.stop());
  const failures: { fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    error: (fields: Record<string, unknown>, message: string) =>
      failures.push({ fields, message }),
  } as unknown as Logger;
  return { invocation, identity, logger, failures, masterKey, heartbeats };
}

const clientOperation = {
  ...operation,
  id: "test.client.read",
  access: AccessPolicy.Client,
} as const;
const UNKNOWN_FAILURE = "gateway.invocation.unknown";
const CANCELLED_FAILURE = "gateway.invocation.cancelled";

test("a request abort during the machine recheck answers cancelled and logs no failure", async (t) => {
  const registry = new OperationRegistry();
  registry.register(clientOperation, () => assert.fail("Unexpected handler"));
  const request = new CancellationContext();
  const h = machineInvocation(t, registry, async (context) => {
    request.cancel();
    await Promise.resolve();
    context.signal.throwIfAborted();
  });
  const response = await h.invocation.invoke(clientOperation.id, input, {
    identity: h.identity,
    context: request,
    logger: h.logger,
  });
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  assert.equal(
    (response.body as { error: { code: string } }).error.code,
    CANCELLED_FAILURE,
  );
  assert.deepEqual(h.failures, []);
});

test("an unknown failure answers 500 and logs the error with the request and the operation", async (t) => {
  const registry = new OperationRegistry();
  const failure = new Error("handler bug");
  registry.register(clientOperation, () => {
    throw failure;
  });
  const h = machineInvocation(t, registry, async () => {});
  const requestId = createIdentity("request");
  const response = await h.invocation.invoke(clientOperation.id, input, {
    identity: h.identity,
    requestId,
    logger: h.logger,
  });
  assert.equal(response.status, HttpStatus.InternalServerError);
  assert.equal(
    (response.body as { error: { code: string } }).error.code,
    UNKNOWN_FAILURE,
  );
  assert.deepEqual(h.failures, [
    {
      fields: {
        err: failure,
        request_id: requestId,
        operation: clientOperation.id,
      },
      message: "Request failed",
    },
  ]);
});

const NO_HANDLER_CALLS = 0;
const ONE_HANDLER_CALL = 1;
const NO_RESERVE_CALLS = 0;
const ONE_RESERVE_CALL = 1;
const ONE_HEARTBEAT = 1;
const ENDED_CODE = "worker.registration.ended";
const ENDED_MESSAGE = "The worker group of the registration ended.";
const ENDED_PATH = "/api/test/ended";
const TOKEN_LIFETIME = 600;
const endedOperation = {
  ...clientOperation,
  id: "test.client.ended",
  path: ENDED_PATH,
  requiresRegistration: false,
  endedGroup: { code: ENDED_CODE, message: ENDED_MESSAGE },
} as const;
const endedMutation = {
  ...endedOperation,
  id: "test.client.ended_mutation",
  path: "/api/test/ended_mutation",
  method: "DELETE",
  mutation: true,
} as const;
const plainOperation = {
  ...clientOperation,
  id: "test.client.plain",
  path: "/api/test/plain",
  requiresRegistration: false,
} as const;

async function endedToken(masterKey: string, identity: { projectId: string }) {
  return (
    await generateMachineJWT(masterKey, AUTH_VERSION, TOKEN_LIFETIME, {
      projectId: identity.projectId,
      bindingName: "general",
    })
  ).token;
}

test("an operation with an ended group answer answers 404 for an ended group and runs no handler", async (t) => {
  let calls = 0;
  const registry = new OperationRegistry();
  registry.register(endedOperation, () => {
    calls++;
    return COMMITTED_VALUE;
  });
  const h = machineInvocation(t, registry, async () => {}, true);
  const token = await endedToken(h.masterKey, h.identity);
  for (const credential of [
    { authorization: `Bearer ${token}` },
    { identity: h.identity },
  ]) {
    const response = await h.invocation.invoke(
      endedOperation.id,
      input,
      credential,
    );
    assert.equal(response.status, HttpStatus.NotFound);
    assert.deepEqual(
      (response.body as { error: { code: string; message: string } }).error,
      { code: ENDED_CODE, message: ENDED_MESSAGE, details: null },
    );
  }
  assert.equal(calls, NO_HANDLER_CALLS);
});

test("a native group with no listed instance runs the handler for a live registration and answers 401 for none", async (t) => {
  let calls = 0;
  const registry = new OperationRegistry();
  registry.register(endedOperation, () => {
    calls++;
    return COMMITTED_VALUE;
  });
  const live = machineInvocation(t, registry, async () => {}, false, {
    registered: true,
  });
  const answered = await live.invocation.invoke(endedOperation.id, input, {
    identity: live.identity,
  });
  assert.equal(answered.status, HttpStatus.OK);
  assert.equal(calls, ONE_HANDLER_CALL);
  const none = machineInvocation(t, registry, async () => {}, false, {
    registered: false,
  });
  const refused = await none.invocation.invoke(endedOperation.id, input, {
    identity: none.identity,
  });
  assert.equal(refused.status, HttpStatus.Unauthorized);
  assert.equal(
    (refused.body as { error: { code: string } }).error.code,
    UNAUTHORIZED,
  );
  assert.equal(calls, ONE_HANDLER_CALL);
});

test("an ended group answer of a mutation records no idempotency answer and sends no heartbeat", async (t) => {
  let calls = 0;
  const registry = new OperationRegistry();
  registry.register(endedMutation, () => {
    calls++;
    return COMMITTED_VALUE;
  });
  const h = machineInvocation(t, registry, async () => {}, true);
  const reserve = t.mock.method(h.invocation.idempotency, "reserve");
  const token = await endedToken(h.masterKey, h.identity);
  for (const credential of [
    { authorization: `Bearer ${token}` },
    { identity: h.identity },
  ]) {
    const response = await h.invocation.invoke(endedMutation.id, input, {
      ...credential,
      idempotencyKey: createIdempotencyKey(),
    });
    assert.equal(response.status, HttpStatus.NotFound);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      ENDED_CODE,
    );
  }
  assert.equal(calls, NO_HANDLER_CALLS);
  assert.equal(reserve.mock.callCount(), NO_RESERVE_CALLS);
  assert.deepEqual(h.heartbeats, []);
  const controlRegistry = new OperationRegistry();
  controlRegistry.register(endedMutation, () => COMMITTED_VALUE);
  const control = machineInvocation(t, controlRegistry, async () => {}, false);
  const controlReserve = t.mock.method(
    control.invocation.idempotency,
    "reserve",
  );
  const answer = await control.invocation.invoke(endedMutation.id, input, {
    identity: control.identity,
    idempotencyKey: createIdempotencyKey(),
  });
  assert.equal(answer.status, HttpStatus.OK);
  assert.equal(controlReserve.mock.callCount(), ONE_RESERVE_CALL);
  assert.equal(control.heartbeats.length, ONE_HEARTBEAT);
});

test("an operation with no ended group answer answers 401 for an ended group", async (t) => {
  const registry = new OperationRegistry();
  registry.register(plainOperation, () => assert.fail("Unexpected handler"));
  const h = machineInvocation(t, registry, async () => {}, true);
  const token = await endedToken(h.masterKey, h.identity);
  for (const credential of [
    { authorization: `Bearer ${token}` },
    { identity: h.identity },
  ]) {
    const response = await h.invocation.invoke(
      plainOperation.id,
      input,
      credential,
    );
    assert.equal(response.status, HttpStatus.Unauthorized);
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      UNAUTHORIZED,
    );
  }
});
