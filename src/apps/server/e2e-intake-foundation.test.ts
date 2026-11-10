import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
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
import { createIdempotencyKey } from "../../kernel/identity.ts";

const NOT_FOUND = "gateway.routing.not_found";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const input = { params: {}, query: {}, body: null };

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
      "idempotency-key": createIdempotencyKey(),
    },
  });
  assert.equal(routed.status, HttpStatus.NotFound);
  assert.equal(errorSchema.parse(await routed.json()).error.code, NOT_FOUND);
  const client = directClient({ servicePing }, fixture.invocation);
  const completed = await client.servicePing(input, {
    identity: mintServiceIdentity(INTAKE_SERVICE_NAME),
    idempotencyKey: createIdempotencyKey(),
  });
  assert.equal(completed.type, OperationResultType.Completed);
  if (completed.type !== OperationResultType.Completed) return;
  assert.deepEqual(completed.data, { pong: true });
  const refused = await client.servicePing(input, {
    identity: testHumanIdentity("ulrich", "Ulrich", ulid()),
    idempotencyKey: createIdempotencyKey(),
  });
  assert.equal(refused.type, OperationResultType.Failure);
  if (refused.type !== OperationResultType.Failure) return;
  assert.equal(refused.status, HttpStatus.Unauthorized);
  assert.equal(refused.error.error.code, UNAUTHORIZED);
});
