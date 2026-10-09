import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { gatewayOperations } from "../../gateway/contract.ts";
import { directClient } from "../../gateway/index.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { HttpMethod, HttpStatus, MediaType } from "../../kernel/http.ts";
import {
  OperationRegistry,
  OperationResultType,
} from "../../kernel/operation.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { gatewayFixture, servicePing } from "./test-support.ts";

const NOT_FOUND = "gateway.routing.not_found";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const FIXTURE_SERVICE_NAMES = [
  "gateway",
  "custody",
  "scheduler",
  "worker",
  "repository",
  "project",
  "mission",
  "intake",
];
const EMPTY_OWNER = { global: {}, projects: {} };
const input = { params: {}, query: {}, body: null };

test("E01.1 liveness answers the intake events probe beside the existing maps", async (t) => {
  const fixture = await gatewayFixture(t);
  const response = await fixture.request(gatewayOperations.liveness.path);
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.liveness.output.parse(await response.json());
  assert.deepEqual(body.services.intake, { events: HttpStatus.OK });
  assert.deepEqual(
    Object.keys(body.services).sort(),
    [...FIXTURE_SERVICE_NAMES].sort(),
  );
});

test("E01.2 healthcheck answers an empty intake owner", async (t) => {
  const fixture = await gatewayFixture(t);
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.services.intake, EMPTY_OWNER);
});

test("E01.3 a service operation has no route and serves a minted service identity alone", async (t) => {
  const registry = new OperationRegistry();
  registry.register(servicePing, (_input, caller) =>
    caller.commit(() => ({ pong: true as const })),
  );
  const fixture = await gatewayFixture(t, { registry });
  const routed = await fixture.request(servicePing.path, {
    method: HttpMethod.Post,
    headers: {
      authorization: `Bearer ${fixture.token}`,
      "content-type": MediaType.JSON,
      "idempotency-key": ulid(),
    },
  });
  assert.equal(routed.status, HttpStatus.NotFound);
  assert.equal(errorSchema.parse(await routed.json()).error.code, NOT_FOUND);
  const client = directClient({ servicePing }, fixture.invocation);
  const completed = await client.servicePing(input, {
    identity: mintServiceIdentity(INTAKE_SERVICE_NAME),
    idempotencyKey: ulid(),
  });
  assert.equal(completed.type, OperationResultType.Completed);
  if (completed.type !== OperationResultType.Completed) return;
  assert.deepEqual(completed.data, { pong: true });
  const refused = await client.servicePing(input, {
    identity: testHumanIdentity("ulrich", "Ulrich", ulid()),
    idempotencyKey: ulid(),
  });
  assert.equal(refused.type, OperationResultType.Failure);
  if (refused.type !== OperationResultType.Failure) return;
  assert.equal(refused.status, HttpStatus.Unauthorized);
  assert.equal(refused.error.error.code, UNAUTHORIZED);
});
