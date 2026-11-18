import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import type { Logger } from "pino";
import { z } from "zod";
import { type CallerIdentity, IdentityKind } from "../kernel/caller.ts";
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
import {
  generateGuestJWT,
  generateHumanJWT,
  generateMachineJWT,
} from "./auth/jwt.ts";
import { createIdempotencyKey, createIdentity } from "../kernel/identity.ts";
import {
  testHumanIdentity,
  testMachineIdentity,
  testReadOnlyIdentity,
  testServiceIdentity,
} from "../kernel/test-identity.ts";
import {
  type ProjectBoundPrefix,
  type ProjectLookup,
  ProjectScope,
  ProjectScopeRule,
} from "../kernel/project-scope.ts";
import { fakeLookups, gatewayFixture } from "./test-support.ts";
import type { ExecutionProofRow } from "../kernel/operation.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const AUTH_VERSION = 1;
const GUEST_LIFETIME_MS = 600_000;

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
const SERVICE_REFUSED = "gateway.access.service_refused";

async function fixture(t: TestContext, registry: OperationRegistry) {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    authVersion: AUTH_VERSION,
  });
  stopAfter(t, () => invocation.stop());
  const { token } = await generateHumanJWT(masterKey, AUTH_VERSION, 600);
  return { invocation, token };
}

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
  stopAfter(t, () => store.close());
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
  stopAfter(t, () => invocation.stop());
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

function machineInvocation(
  t: TestContext,
  registry: OperationRegistry,
  resolveWorkerGroup: (context: Context) => Promise<void>,
  ended = false,
  drained: { registered: boolean } | null = null,
) {
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
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
  stopAfter(t, () => invocation.stop());
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
    assert.equal(
      (response.body as { error: { code: string } }).error.code,
      ENDED_CODE,
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

const humanOrService = {
  ...operation,
  id: "test.human_or_service",
  path: "/api/test/human-or-service",
  access: AccessPolicy.HumanOrService,
  services: ["footprint"],
  output: z.string(),
} as const;

test("human_or_service accepts a human and the listed service, and refuses every other service identity with gateway.access.service_refused", async (t) => {
  const registry = new OperationRegistry();
  registry.register(
    humanOrService,
    (_input, caller) => caller.identity?.kind ?? "none",
  );
  const { invocation, token } = await fixture(t, registry);
  const human = await invocation.invoke(humanOrService.id, input, {
    authorization: `Bearer ${token}`,
  });
  assert.equal(human.status, HttpStatus.OK);
  assert.equal(human.body, IdentityKind.Human);
  const listed = await invocation.invoke(humanOrService.id, input, {
    identity: testServiceIdentity("footprint"),
  });
  assert.equal(listed.status, HttpStatus.OK);
  assert.equal(listed.body, IdentityKind.Service);
  const other = await invocation.invoke(humanOrService.id, input, {
    identity: testServiceIdentity("mission"),
  });
  assert.equal(other.status, HttpStatus.Forbidden);
  assert.equal(
    (other.body as { error: { code: string } }).error.code,
    SERVICE_REFUSED,
  );
});

test("the idempotency caller key of a guest mutation is guest:<guest_id>", async (t) => {
  const guestOperation = {
    ...operation,
    id: "test.guest.write",
    method: "POST",
    path: "/api/test/guest-write",
    access: AccessPolicy.Guest,
    mutation: true,
  } as const;
  const registry = new OperationRegistry();
  registry.register(guestOperation, (_input, caller) =>
    caller.commit(() => COMMITTED_VALUE),
  );
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const masterKey = randomBytes(MASTER_KEY_BYTES).toString("base64");
  const inviteId = createIdentity("workbench_invite");
  const guestId = createIdentity("workbench_guest");
  const expiresAt = Date.now() + GUEST_LIFETIME_MS;
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey,
    authVersion: AUTH_VERSION,
    lookups: {
      project: {
        resolveWorkerGroup: async () => null,
        workerGroupEnded: async () => false,
      },
      worker: { findByClient: () => undefined, heartbeat: () => {} },
      workbench: {
        resolveInvite: () => ({
          session_id: createIdentity("workbench_session"),
          invited_by: "ulrich",
          expires_at: expiresAt,
          project_ids: [],
          granted_operations: [],
        }),
        claimGrant: () => null,
      },
    },
  });
  stopAfter(t, () => invocation.stop());
  const { token } = await generateGuestJWT(masterKey, AUTH_VERSION, {
    guestId,
    name: "Mira",
    inviteId,
    expiresAt,
  });
  const reserve = t.mock.method(invocation.idempotency, "reserve");
  const answer = await invocation.invoke(guestOperation.id, input, {
    authorization: `Bearer ${token}`,
    idempotencyKey: createIdempotencyKey(),
  });
  assert.equal(answer.status, HttpStatus.OK);
  assert.equal(reserve.mock.callCount(), ONE_RESERVE_CALL);
  assert.equal(reserve.mock.calls[0]!.arguments[1], `guest:${guestId}`);
});

const SHARED_REQUEST_ID = createIdentity("request");
const ANSWER_REFUSED_MESSAGE = "gateway.scope.answer_refused";
const SCOPE_REFUSED = "gateway.scope.refused";
const SCOPE_NOT_FOUND = "gateway.scope.not_found";
const scopedInput = z.strictObject({
  params: z.strictObject({ id: z.string() }),
  query: z.strictObject({}),
  body: z.null(),
});
const scopedRead = {
  ...operation,
  id: "test.scope.read",
  path: "/api/test/scope/:id",
  input: scopedInput,
  output: z.unknown(),
  projectScope: ProjectScopeRule.Target,
} as const;
const scopedMutation = {
  ...scopedRead,
  id: "test.scope.mutation",
  method: "POST",
  mutation: true,
} as const;
const scopedList = {
  ...operation,
  id: "test.scope.list",
  path: "/api/test/scope",
  input: z.strictObject({
    params: z.strictObject({}),
    query: z.strictObject({ id: z.array(z.string()).optional() }),
    body: z.null(),
  }),
  output: z.unknown(),
  projectScope: ProjectScopeRule.List,
} as const;

class CountingLookup implements ProjectLookup {
  readonly owners = new Map<string, string>();
  calls = 0;
  projectOf(_prefix: ProjectBoundPrefix, id: string): string | null {
    this.calls += 1;
    return this.owners.get(id) ?? null;
  }
}

async function scopeFixture(
  t: TestContext,
  options: { wired?: boolean; projectIds?: readonly string[] } = {},
) {
  const registry = new OperationRegistry();
  const handlerCalls: unknown[] = [];
  let answer: unknown = COMMITTED_VALUE;
  const handler = (handlerInput: unknown) => {
    handlerCalls.push(handlerInput);
    return answer;
  };
  registry.register(scopedRead, handler);
  registry.register(scopedMutation, handler);
  registry.register(scopedList, handler);
  const store = new Store(":memory:");
  stopAfter(t, () => store.close());
  store.migrate([{ service: "gateway", migrations: gatewayMigrations }]);
  registry.seal({ [StoreName.Operational]: store });
  const lookups = fakeLookups();
  const inviteId = createIdentity("workbench_invite");
  const projectId = createIdentity("project");
  const projectIds = options.projectIds ?? [projectId];
  lookups.workbench.invites.set(inviteId, {
    session_id: createIdentity("workbench_session"),
    invited_by: "ulrich",
    expires_at: Date.now() + GUEST_LIFETIME_MS,
    project_ids: projectIds,
    granted_operations: [],
  });
  const lookup = new CountingLookup();
  const invocation = createInvocation({
    registry,
    stores: { [StoreName.Operational]: store },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    authVersion: AUTH_VERSION,
    lookups,
    ...(options.wired === false
      ? {}
      : { projectScope: new ProjectScope(lookup) }),
  });
  stopAfter(t, () => invocation.stop());
  const errors: { fields: Record<string, unknown>; message: string }[] = [];
  const logger = {
    error: (fields: Record<string, unknown>, message: string) =>
      errors.push({ fields, message }),
  } as unknown as Logger;
  return {
    invocation,
    lookups,
    lookup,
    inviteId,
    projectId,
    handlerCalls,
    errors,
    logger,
    reader: testReadOnlyIdentity("ulrich", {
      inviteId,
      projectIds,
      guestName: "Mira",
    }),
    setAnswer: (value: unknown) => {
      answer = value;
    },
  };
}

function errorCodeOf(response: { body: unknown }): string {
  return (response.body as { error: { code: string } }).error.code;
}

test("security: a direct mutation under the read-only identity answers 401, and a direct read after a revoke answers 401", async (t) => {
  const f = await scopeFixture(t);
  const params = { id: createIdentity("node") };
  const mutation = await f.invocation.invoke(
    scopedMutation.id,
    { params, query: {}, body: null },
    { identity: f.reader, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(mutation.status, HttpStatus.Unauthorized);
  assert.equal(errorCodeOf(mutation), UNAUTHORIZED);
  assert.deepEqual(f.handlerCalls, []);
  f.lookups.workbench.invites.delete(f.inviteId);
  const read = await f.invocation.invoke(
    scopedRead.id,
    { params, query: {}, body: null },
    { identity: f.reader },
  );
  assert.equal(read.status, HttpStatus.Unauthorized);
});

test("invariant: a refused mutation under the read-only identity reserves no idempotency key", async (t) => {
  const f = await scopeFixture(t);
  const reserve = t.mock.method(f.invocation.idempotency, "reserve");
  const response = await f.invocation.invoke(
    scopedMutation.id,
    { params: { id: createIdentity("node") }, query: {}, body: null },
    { identity: f.reader, idempotencyKey: createIdempotencyKey() },
  );
  assert.equal(response.status, HttpStatus.Unauthorized);
  assert.equal(reserve.mock.callCount(), NO_RESERVE_CALLS);
});

test("security: a handler answer with a foreign project_id answers 404 and logs one error line", async (t) => {
  const f = await scopeFixture(t);
  const nodeId = createIdentity("node");
  f.lookup.owners.set(nodeId, f.projectId);
  f.setAnswer({ project_id: createIdentity("project") });
  const response = await f.invocation.invoke(
    scopedRead.id,
    { params: { id: nodeId }, query: {}, body: null },
    { identity: f.reader, logger: f.logger, requestId: SHARED_REQUEST_ID },
  );
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(errorCodeOf(response), SCOPE_NOT_FOUND);
  assert.equal(f.handlerCalls.length, ONE_HANDLER_CALL);
  assert.equal(f.errors.length, ONE_HANDLER_CALL);
  assert.equal(f.errors[0]!.message, ANSWER_REFUSED_MESSAGE);
});

test("security: an absent and a foreign record answer equal 404 bodies after equal lookup counts", async (t) => {
  const f = await scopeFixture(t);
  const foreign = createIdentity("node");
  f.lookup.owners.set(foreign, createIdentity("project"));
  const ask = async (id: string) => {
    const before = f.lookup.calls;
    const response = await f.invocation.invoke(
      scopedRead.id,
      { params: { id }, query: {}, body: null },
      { identity: f.reader, requestId: SHARED_REQUEST_ID },
    );
    return { response, lookups: f.lookup.calls - before };
  };
  const absent = await ask(createIdentity("node"));
  const other = await ask(foreign);
  assert.equal(absent.response.status, HttpStatus.NotFound);
  assert.equal(
    JSON.stringify(absent.response.body),
    JSON.stringify(other.response.body),
  );
  assert.equal(absent.lookups, other.lookups);
  assert.deepEqual(f.handlerCalls, []);
});

test("security: a read-only identity with an empty set refuses every scoped operation", async (t) => {
  const f = await scopeFixture(t, { projectIds: [] });
  const nodeId = createIdentity("node");
  f.lookup.owners.set(nodeId, f.projectId);
  const read = await f.invocation.invoke(
    scopedRead.id,
    { params: { id: nodeId }, query: {}, body: null },
    { identity: f.reader },
  );
  assert.equal(read.status, HttpStatus.NotFound);
  const list = await f.invocation.invoke(
    scopedList.id,
    { params: {}, query: {}, body: null },
    { identity: f.reader },
  );
  assert.deepEqual(list.body, { items: [], next_cursor: null });
  assert.deepEqual(f.handlerCalls, []);
});

test("security: a scoped list drops a foreign id before the handler", async (t) => {
  const f = await scopeFixture(t);
  const response = await f.invocation.invoke(
    scopedList.id,
    {
      params: {},
      query: { id: [createIdentity("project"), f.projectId] },
      body: null,
    },
    { identity: f.reader },
  );
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(f.handlerCalls, [
    { params: {}, query: { id: [f.projectId] }, body: null },
  ]);
});

test("security: with no projectScope in createInvocation, a scoped read answers 403 gateway.scope.refused", async (t) => {
  const f = await scopeFixture(t, { wired: false });
  const response = await f.invocation.invoke(
    scopedRead.id,
    { params: { id: createIdentity("node") }, query: {}, body: null },
    { identity: f.reader },
  );
  assert.equal(response.status, HttpStatus.Forbidden);
  assert.equal(errorCodeOf(response), SCOPE_REFUSED);
  assert.deepEqual(f.handlerCalls, []);
});

const GRANT_REFUSED = "gateway.grant.refused";
const INVITER = "ulrich";
const TOOL_CALL = "tool-call-1";

function grantOf(sessionId = createIdentity("workbench_session")) {
  return { sessionId, toolCallId: TOOL_CALL };
}

function grantedCall(
  f: Awaited<ReturnType<typeof scopeFixture>>,
  nodeId: string,
  options: { identity?: CallerIdentity; grant?: ReturnType<typeof grantOf> },
) {
  return f.invocation.invoke(
    scopedMutation.id,
    { params: { id: nodeId }, query: {}, body: null },
    {
      identity: options.identity ?? f.reader,
      grant: options.grant ?? grantOf(),
      idempotencyKey: createIdempotencyKey(),
    },
  );
}

test("(security) a read-only identity with grant and a claim that answers null gets 401 gateway.grant.refused", async (t) => {
  const f = await scopeFixture(t);
  const reserve = t.mock.method(f.invocation.idempotency, "reserve");
  const response = await grantedCall(f, createIdentity("node"), {});
  assert.equal(response.status, HttpStatus.Unauthorized);
  assert.equal(errorCodeOf(response), GRANT_REFUSED);
  assert.equal(f.lookups.workbench.claims.length, ONE_RESERVE_CALL);
  assert.deepEqual(f.handlerCalls, []);
  assert.equal(reserve.mock.callCount(), NO_RESERVE_CALLS);
});

test("(security) a claim that answers another invitedBy gives 401 gateway.grant.refused", async (t) => {
  const f = await scopeFixture(t);
  f.lookups.workbench.claimAnswer = {
    invitedBy: "mallory",
    projectIds: [f.projectId],
  };
  const response = await grantedCall(f, createIdentity("node"), {});
  assert.equal(response.status, HttpStatus.Unauthorized);
  assert.equal(errorCodeOf(response), GRANT_REFUSED);
  assert.deepEqual(f.handlerCalls, []);
});

test("(security) grant with a plain human identity and grant on a read answer 401 gateway.grant.refused", async (t) => {
  const f = await scopeFixture(t);
  f.lookups.workbench.claimAnswer = {
    invitedBy: INVITER,
    projectIds: [f.projectId],
  };
  const plain = await grantedCall(f, createIdentity("node"), {
    identity: testHumanIdentity(INVITER, "Ulrich", "plain"),
  });
  assert.equal(plain.status, HttpStatus.Unauthorized);
  assert.equal(errorCodeOf(plain), GRANT_REFUSED);
  const read = await f.invocation.invoke(
    scopedRead.id,
    { params: { id: createIdentity("node") }, query: {}, body: null },
    { identity: f.reader, grant: grantOf() },
  );
  assert.equal(read.status, HttpStatus.Unauthorized);
  assert.equal(errorCodeOf(read), GRANT_REFUSED);
  assert.deepEqual(f.lookups.workbench.claims, []);
  assert.deepEqual(f.handlerCalls, []);
});

test("a granted mutation inside the scope claims the grant once and runs the handler", async (t) => {
  const f = await scopeFixture(t);
  const nodeId = createIdentity("node");
  f.lookup.owners.set(nodeId, f.projectId);
  f.lookups.workbench.claimAnswer = {
    invitedBy: INVITER,
    projectIds: [f.projectId],
  };
  const response = await grantedCall(f, nodeId, {});
  assert.equal(response.status, HttpStatus.OK);
  assert.equal(f.handlerCalls.length, ONE_RESERVE_CALL);
  const [claim] = f.lookups.workbench.claims;
  assert.equal(claim?.inviteId, f.inviteId);
  assert.equal(claim?.toolCallId, TOOL_CALL);
  assert.equal(claim?.operationId, scopedMutation.id);
});

test("(security) a delegate identity carries the scope: a granted call on a node of another project answers 404 after the claim", async (t) => {
  const f = await scopeFixture(t);
  const nodeId = createIdentity("node");
  f.lookup.owners.set(nodeId, createIdentity("project"));
  f.lookups.workbench.claimAnswer = {
    invitedBy: INVITER,
    projectIds: [f.projectId],
  };
  const reserve = t.mock.method(f.invocation.idempotency, "reserve");
  const response = await grantedCall(f, nodeId, {});
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal(errorCodeOf(response), SCOPE_NOT_FOUND);
  assert.equal(f.lookups.workbench.claims.length, ONE_RESERVE_CALL);
  assert.deepEqual(f.handlerCalls, []);
  assert.equal(reserve.mock.callCount(), NO_RESERVE_CALLS);
});

async function guestMutationFixture(t: TestContext) {
  const registry = new OperationRegistry();
  const handlerCalls: unknown[] = [];
  const route = {
    ...operation,
    id: "test.guest.route",
    method: "POST",
    path: "/api/test/guest-route",
    mutation: true,
    body: true,
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: z.unknown(),
    }),
    output: z.unknown(),
  } as const;
  registry.register(route, (handlerInput) => {
    handlerCalls.push(handlerInput);
    return COMMITTED_VALUE;
  });
  const lookups = fakeLookups();
  const inviteId = createIdentity("workbench_invite");
  const expiresAt = Date.now() + GUEST_LIFETIME_MS;
  lookups.workbench.invites.set(inviteId, {
    session_id: createIdentity("workbench_session"),
    invited_by: INVITER,
    expires_at: expiresAt,
    project_ids: [],
    granted_operations: [],
  });
  lookups.workbench.claimAnswer = { invitedBy: INVITER, projectIds: [] };
  const gateway = await gatewayFixture(t, { registry, lookups });
  const { token } = await generateGuestJWT(
    gateway.config.master_key,
    gateway.config.gateway.auth.version,
    {
      guestId: createIdentity("workbench_guest"),
      name: "Mira",
      inviteId,
      expiresAt,
    },
  );
  const post = (body: unknown) =>
    gateway.request(route.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": createIdempotencyKey(),
      },
      body: JSON.stringify(body),
    });
  return { post, handlerCalls, lookups };
}

test("(security) a guest JWT on a mutation route answers 401 gateway.authentication.unauthorized", async (t) => {
  const f = await guestMutationFixture(t);
  const response = await f.post({ value: 1 });
  assert.equal(response.status, HttpStatus.Unauthorized);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    UNAUTHORIZED,
  );
  assert.deepEqual(f.handlerCalls, []);
});

test("(security) a guest JWT on a mutation route with a body field grant answers 401 gateway.authentication.unauthorized and claims nothing", async (t) => {
  const f = await guestMutationFixture(t);
  const response = await f.post({
    grant: { sessionId: createIdentity("workbench_session"), toolCallId: "x" },
  });
  assert.equal(response.status, HttpStatus.Unauthorized);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    UNAUTHORIZED,
  );
  assert.deepEqual(f.handlerCalls, []);
  assert.deepEqual(f.lookups.workbench.claims, []);
});
