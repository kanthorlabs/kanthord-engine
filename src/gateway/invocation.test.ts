import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
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
import { generateHumanJWT } from "./local.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  testMachineIdentity,
  testHumanIdentity,
} from "../kernel/test-identity.ts";
import type { ExecutionProofRow } from "../kernel/operation.ts";

const TOKEN_VERSION = 1;

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
    tokenVersion: TOKEN_VERSION,
    tokenLifetime: 600,
  });
  t.after(() => invocation.stop());
  const { token } = await generateHumanJWT(masterKey, TOKEN_VERSION, 600);
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
    runtime_identity: createIdentity("worker_instance"),
    worker_binding_id: createIdentity("binding"),
    attempt: 1,
    pinned_revision: 2,
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
    };
    assert.deepEqual(caller.execution, claim);
    return caller.commit(() => COMMITTED_VALUE);
  });
  registry.seal({ [StoreName.Operational]: store });
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    tokenVersion: TOKEN_VERSION,
    tokenLifetime: 600,
    lookups: {
      project: {
        resolveWorkerGroup: async () => ({
          project_id: identity.projectId,
          resource_identity: identity.resourceIdentity,
        }),
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
  const key = createIdentity("request").slice("request_".length);
  const request = {
    params: { execution_id: row.execution_id },
    query: {},
    body: {},
  };
  for (const candidate of [
    undefined,
    { ...row, runtime_identity: createIdentity("worker_instance") },
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
          idempotencyKey: createIdentity("request").slice("request_".length),
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
