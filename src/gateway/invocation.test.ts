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
    tokenLifetime: 600,
  });
  t.after(() => invocation.stop());
  const { token } = await generateHumanJWT(masterKey, 600);
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
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    nodeId: createIdentity("node"),
    runtimeIdentity: createIdentity("worker_instance"),
    workerBindingId: createIdentity("binding"),
    attempt: 1,
    pinnedRevision: 2,
    expiredAt: now + 100,
    endedAt: null,
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "worker",
      projectId: row.projectId,
      resourceIdentity: "worker:kanthord:general",
      issuedAt: now,
    },
    "machine",
    row.runtimeIdentity,
  );
  let proof: ExecutionProofRow | undefined = row;
  let registered = true;
  const protectedOperation = {
    ...operation,
    access: AccessPolicy.Client,
    mutation: true,
    requiresExecution: true,
    input: z.strictObject({
      params: z.strictObject({ executionId: z.string().optional() }),
      query: z.strictObject({}),
      body: z.strictObject({ executionId: z.string().optional() }),
    }),
  };
  let calls = 0;
  registry.register(protectedOperation, (_input, caller) => {
    calls++;
    const claim = {
      executionId: row.executionId,
      projectId: row.projectId,
      nodeId: row.nodeId,
      runtimeIdentity: row.runtimeIdentity,
      workerBindingId: row.workerBindingId,
      attempt: row.attempt,
      pinnedRevision: row.pinnedRevision,
    };
    assert.deepEqual(caller.execution, claim);
    return caller.commit(() => COMMITTED_VALUE);
  });
  registry.seal({ [StoreName.Operational]: store });
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    tokenLifetime: 600,
    lookups: {
      project: {
        resolveWorkerGroup: async () => ({
          projectId: identity.projectId,
          resourceIdentity: identity.resourceIdentity,
        }),
      },
      worker: {
        findByClient: () =>
          registered
            ? {
                runtimeIdentity: row.runtimeIdentity,
                registeredAt: now,
                clientId: identity.clientId,
                name: identity.name,
                projectId: identity.projectId,
                resourceIdentity: identity.resourceIdentity,
              }
            : undefined,
        heartbeat: () => {},
      },
      scheduler: {
        executionOf: (id) => (id === row.executionId ? proof : undefined),
      },
    },
  });
  t.after(() => invocation.stop());
  const key = createIdentity("request").slice("request_".length);
  const request = {
    params: { executionId: row.executionId },
    query: {},
    body: {},
  };
  for (const candidate of [
    undefined,
    { ...row, runtimeIdentity: createIdentity("worker_instance") },
    { ...row, endedAt: now },
    { ...row, expiredAt: now },
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
  proof = { ...row, endedAt: now };
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
        { params: {}, query: {}, body: { executionId: row.executionId } },
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
  assert.equal(
    (
      await invocation.invoke(operation.id, request, {
        identity: unregistered,
        idempotencyKey: key,
      })
    ).status,
    HttpStatus.Forbidden,
  );
});
