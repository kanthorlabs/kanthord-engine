import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import {
  fakeMachines,
  gatewayFixture,
  servicePing,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";
import {
  AccessPolicy,
  OperationRegistry,
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { IdentityKind, type CallerIdentity } from "../../kernel/caller.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpMethod, HttpStatus, MediaType } from "../../kernel/http.ts";
import { directClient } from "../../gateway/index.ts";
import { emitOpenAPIFiles } from "../../gateway/local.ts";

const SERVICE_NAME = "intake";
const DIRECT_PATH = "/api/test/direct-ping";
const SINGLE_CALL = 1;
const NO_CALLS = 0;
const NO_REGISTRATIONS = 0;
const ErrorCode = {
  Unauthorized: "gateway.authentication.unauthorized",
  NotFound: "gateway.routing.not_found",
} as const;
const input = { params: {}, query: {}, body: null };
const directPing = {
  ...servicePing,
  id: "test.direct.ping",
  path: DIRECT_PATH,
  access: AccessPolicy.Human,
  direct: true,
  description: "Test a direct human operation.",
} as const;
const humanPing = {
  ...servicePing,
  id: "test.human.ping",
  path: "/api/test/human-ping",
  access: AccessPolicy.Human,
  description: "Test a routed human operation.",
} as const;
const operations = { servicePing, directPing, humanPing };

async function policyFixture(t: TestContext) {
  const calls = { count: 0 };
  const registry = new OperationRegistry();
  for (const operation of Object.values(operations))
    registry.register(operation, (_input, caller) =>
      caller.commit(() => {
        calls.count++;
        return { pong: true as const };
      }),
    );
  const fixture = await gatewayFixture(t, {
    registry,
    machines: fakeMachines(),
  });
  const machine = await fixture.gateway.authentication.authenticate(
    `Bearer ${await fixture.machineToken(TEST_PROJECT_ID, TEST_WORKER_BINDING)}`,
  );
  const client = directClient(operations, fixture.invocation);
  return { fixture, calls, machine, client };
}

function assertUnauthorized(result: OperationResult<unknown>): void {
  assert.equal(result.type, OperationResultType.Failure);
  if (result.type !== OperationResultType.Failure) return;
  assert.equal(result.status, HttpStatus.Unauthorized);
  assert.equal(result.error.error.code, ErrorCode.Unauthorized);
}

async function assertNoRoute(
  fixture: Awaited<ReturnType<typeof gatewayFixture>>,
  path: string,
): Promise<void> {
  const response = await fixture.request(path, {
    method: HttpMethod.Post,
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": MediaType.JSON,
      "idempotency-key": ulid(),
    },
  });
  assert.equal(response.status, HttpStatus.NotFound);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, ErrorCode.NotFound);
}

function emittedPaths(
  fixture: Awaited<ReturnType<typeof gatewayFixture>>,
): string[] {
  const files = emitOpenAPIFiles(
    fixture.gateway.registry.all().map(({ operation }) => operation),
  );
  return Object.keys(files["openapi.yaml"].paths);
}

test("a minted service identity completes a service operation and replays a repeated key", async (t) => {
  const { client, calls } = await policyFixture(t);
  const identity = mintServiceIdentity(SERVICE_NAME);
  const idempotencyKey = ulid();
  const first = await client.servicePing(input, { identity, idempotencyKey });
  const second = await client.servicePing(input, { identity, idempotencyKey });
  for (const result of [first, second]) {
    assert.equal(result.type, OperationResultType.Completed);
    if (result.type !== OperationResultType.Completed) return;
    assert.deepEqual(result.data, { pong: true });
  }
  assert.equal(calls.count, SINGLE_CALL);
});

test("a service operation refuses a human, a machine and a structural copy", async (t) => {
  const { client, machine, calls } = await policyFixture(t);
  const identities: CallerIdentity[] = [
    testHumanIdentity("ulrich", "Ulrich", "token"),
    machine,
    { kind: IdentityKind.Service, service: SERVICE_NAME },
  ];
  for (const identity of identities)
    assertUnauthorized(
      await client.servicePing(input, { identity, idempotencyKey: ulid() }),
    );
  assert.equal(calls.count, NO_CALLS);
});

test("a human operation refuses a service identity", async (t) => {
  const { client, calls } = await policyFixture(t);
  assertUnauthorized(
    await client.humanPing(input, {
      identity: mintServiceIdentity(SERVICE_NAME),
      idempotencyKey: ulid(),
    }),
  );
  assert.equal(calls.count, NO_CALLS);
});

test("a direct human operation serves a forwarded human and refuses a machine", async (t) => {
  const { client, machine, calls } = await policyFixture(t);
  const completed = await client.directPing(input, {
    identity: testHumanIdentity("ulrich", "Ulrich", "token"),
    idempotencyKey: ulid(),
  });
  assert.equal(completed.type, OperationResultType.Completed);
  assertUnauthorized(
    await client.directPing(input, {
      identity: machine,
      idempotencyKey: ulid(),
    }),
  );
  assert.equal(calls.count, SINGLE_CALL);
});

test("the HTTP adapter and OpenAPI expose no service or direct operation", async (t) => {
  const { fixture, calls } = await policyFixture(t);
  await assertNoRoute(fixture, servicePing.path);
  await assertNoRoute(fixture, DIRECT_PATH);
  const paths = emittedPaths(fixture);
  assert.ok(paths.includes(humanPing.path));
  assert.equal(paths.includes(servicePing.path), false);
  assert.equal(paths.includes(DIRECT_PATH), false);
  assert.equal(calls.count, NO_CALLS);
});

test("register refuses a direct flag outside the human and client policies", () => {
  const registry = new OperationRegistry();
  const refused = [
    { ...servicePing, direct: true },
    {
      ...servicePing,
      access: AccessPolicy.Public,
      mutation: false,
      direct: true,
    },
    {
      ...servicePing,
      access: AccessPolicy.Delivery,
      mutation: false,
      delivery: true,
      direct: true,
    },
  ] as const;
  for (const operation of refused)
    assert.throws(
      () => registry.register(operation, () => ({ pong: true as const })),
      /Only a human or client operation is direct/,
    );
  assert.equal(registry.all().length, NO_REGISTRATIONS);
});

test("register refuses a service operation with an execution, registration, delivery or secret field", () => {
  const registry = new OperationRegistry();
  const refused = [
    { ...servicePing, requiresExecution: true },
    { ...servicePing, requiresRegistration: false },
    { ...servicePing, delivery: true },
    { ...servicePing, secret: true },
  ] as const;
  for (const operation of refused)
    assert.throws(
      () => registry.register(operation, () => ({ pong: true as const })),
      /A service operation declares no/,
    );
  assert.equal(registry.all().length, NO_REGISTRATIONS);
});
