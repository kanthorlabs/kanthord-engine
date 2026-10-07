import { HttpStatus } from "../kernel/http.ts";
import {
  emptyInput,
  OperationRegistry,
  StoreName,
  OperationLifetime,
} from "../kernel/operation.ts";
import { gatewayFixture } from "./test-support.ts";
const REQUEST_LOG_RECORD_COUNT = 2;
import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { z } from "zod";
import { createIdentity, ulidSchema } from "../kernel/identity.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { errorSchema } from "../kernel/errors.ts";
import { httpClient } from "./client.ts";
import { failure, unauthorized } from "./errors.ts";
import { Idempotency } from "./idempotency.ts";
import { gatewayOperations } from "./contract.ts";
import { workerOperations } from "../worker/contract.ts";
import { emitOpenAPIFiles } from "./openapi.ts";
import { requestIdSchema, resolveRequestId } from "./request-id.ts";
const apiOperations = { ...gatewayOperations, ...workerOperations };
const requestId = "request_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const invalidIds = [
  ulid(),
  createIdentity("project"),
  requestId.toLowerCase(),
  "request_8" + "Z".repeat(25),
  requestId + "0",
  "arbitrary-correlation-id",
];

test("request IDs preserve accepted values and replace absent or invalid values", () => {
  assert.equal(resolveRequestId(requestId), requestId);
  const generated = new Set<string>();
  for (const input of [undefined, "", ...invalidIds, `${requestId}\n`]) {
    const value = resolveRequestId(input);
    assert.equal(requestIdSchema.parse(value), value);
    assert.notEqual(value, input);
    generated.add(value);
  }
  assert.equal(generated.size, invalidIds.length + 3);
});

test("clients treat a failure with a bare or wrong-kind request ID as indeterminate", async () => {
  const operation = apiOperations.verify;
  for (const invalid of invalidIds) {
    const body = failure(unauthorized(), invalid).body;
    assert.equal(errorSchema.safeParse(body).success, false);
    const client = httpClient(
      { operation },
      "http://localhost",
      undefined,
      async () => Response.json(body, { status: 401 }),
    );
    const result = await client.operation({
      params: {},
      query: {},
      body: null,
    });
    assert.equal(result.type, OperationResultType.Indeterminate);
  }
});

test("idempotency records retain full request IDs while their keys remain bare ULIDs", async (t) => {
  const idempotency = new Idempotency();
  t.after(() => idempotency.stop());
  const key = ulid();
  const { reservation } = idempotency.reserve(
    key,
    "human",
    "test.write",
    "digest",
  );
  const response = failure(unauthorized(), requestId);
  idempotency.complete(reservation, response);
  const replay = idempotency.reserve(key, "human", "test.write", "digest");
  assert.deepEqual(replay.replay, response);
  assert.equal(replay.reservation.key, key);
  assert.deepEqual(replay.replay, response);
  for (const invalid of [requestId, createIdentity("project"), `${key}\n`]) {
    assert.equal(ulidSchema.safeParse(invalid).success, false);
    assert.throws(
      () => idempotency.reserve(invalid, "human", "test.write", "digest"),
      /canonical ULID/,
    );
  }
});

test("OpenAPI publishes the same request-ID and idempotency-key formats as validation", () => {
  const files = emitOpenAPIFiles(Object.values(apiOperations));
  const shared = files["openapi/shared/components.yaml"] as {
    components: {
      schemas: { Error: { properties: { request_id: object } } };
      parameters: { IdempotencyKey: { schema: { pattern: string } } };
    };
  };
  const { $schema: dialect, ...schema } = z.toJSONSchema(requestIdSchema);
  assert.ok(dialect?.includes("json-schema"));
  assert.deepEqual(
    shared.components.schemas.Error.properties.request_id,
    schema,
  );
  const keyPattern = new RegExp(
    shared.components.parameters.IdempotencyKey.schema.pattern,
  );
  assert.ok(keyPattern.test(ulid()));
  assert.equal(keyPattern.test(requestId), false);
});

test("HTTP responses and logs share the validated prefixed request ID, including routing failures", async (t) => {
  const fixture = await gatewayFixture(t);
  for (const supplied of [undefined, requestId, ...invalidIds]) {
    const start = fixture.logs.length;
    const response = await fixture.request("/missing", {
      headers: supplied === undefined ? {} : { "X-Request-Id": supplied },
    });
    assert.equal(response.status, HttpStatus.NotFound);
    const body = errorSchema.parse(await response.json());
    const id = requestIdSchema.parse(response.headers.get("x-request-id"));
    assert.equal(body.request_id, id);
    if (supplied === requestId) assert.equal(id, supplied);
    else assert.notEqual(id, supplied);
    const logs = fixture.logs.slice(start).map((line) => JSON.parse(line));
    assert.equal(logs.length, REQUEST_LOG_RECORD_COUNT);
    for (const log of logs) assert.equal(log.requestId, id);
  }
});

test("HTTP and direct invocations forward only canonical request IDs to handlers", async (t) => {
  const registry = new OperationRegistry();
  const operation = {
    id: "test.request",
    service: "test",
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    method: "GET",
    path: "/api/test/request",
    access: "public",
    timeoutMs: 1000,
    mutation: false,
    input: emptyInput,
    output: z.strictObject({ requestId: requestIdSchema }),
    status: 200,
    description: "Expose the request ID seen by a test handler.",
  } as const;
  registry.register(operation, (_input, caller) => {
    assert.ok(requestIdSchema.safeParse(caller.requestId).success);
    assert.equal(caller.request, undefined);
    return { requestId: caller.requestId };
  });
  const fixture = await gatewayFixture(t, { registry });
  for (const supplied of [undefined, requestId, ...invalidIds]) {
    const response = await fixture.request(operation.path, {
      headers: supplied === undefined ? {} : { "X-Request-Id": supplied },
    });
    assert.equal(response.status, HttpStatus.OK);
    const http = operation.output.parse(await response.json());
    assert.equal(http.requestId, response.headers.get("x-request-id"));
    const result = await fixture.gateway.invocation.invoke(
      operation.id,
      { params: {}, query: {}, body: null },
      { requestId: supplied },
    );
    assert.equal(result.status, HttpStatus.OK);
    const direct = operation.output.parse(result.body);
    for (const body of [http, direct]) {
      if (supplied === requestId) assert.equal(body.requestId, supplied);
      else assert.notEqual(body.requestId, supplied);
    }
  }
});
