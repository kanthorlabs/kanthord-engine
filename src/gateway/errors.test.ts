import assert from "node:assert/strict";
import { test } from "node:test";
import { httpClient, OperationResultType } from "./client.ts";
import {
  conflict,
  errorSchema,
  failure,
  GatewayError,
  respondError,
  unauthorized,
} from "./errors.ts";
import { gatewayOperations } from "./operations.ts";

import { HttpStatus } from "../shared/http.ts";

const ExpectedErrorCode = {
  Unknown: "gateway.invocation.unknown",
  Unauthorized: "gateway.authentication.unauthorized",
  Conflict: "gateway.idempotency.conflict",
} as const;
const requestId = "request_01ARZ3NDEKTSV4RRFFQ69G5FAV";

test("declared failures retain their originating code, status, details and request ID", async () => {
  const error = new GatewayError(
    429,
    "project.bindings.llm.openai.quota_exceeded",
    "Provider quota exceeded.",
    { retryAfter: 60 },
  );
  const result = failure(error, requestId);
  assert.equal(result.status, HttpStatus.TooManyRequests);
  assert.deepEqual(errorSchema.parse(result.body), {
    error: {
      code: error.code,
      message: error.message,
      details: { retryAfter: 60 },
    },
    requestId,
  });
  const response = respondError(error, requestId);
  assert.equal(response.status, HttpStatus.TooManyRequests);
  assert.deepEqual(await response.json(), result.body);
});

test("unknown failures are scoped and redacted; shared failures use their owning components", () => {
  const result = failure(new Error("secret-marker"), requestId);
  assert.equal(result.status, HttpStatus.InternalServerError);
  assert.equal(result.body.error.code, ExpectedErrorCode.Unknown);
  assert.equal(result.body.error.details, null);
  assert.doesNotMatch(JSON.stringify(result.body), /secret-marker/);
  assert.equal(unauthorized().code, ExpectedErrorCode.Unauthorized);
  assert.equal(unauthorized().status, HttpStatus.Unauthorized);
  assert.equal(conflict().code, ExpectedErrorCode.Conflict);
  assert.equal(conflict().status, HttpStatus.Conflict);
});

test("constructors and failure envelopes reject legacy and malformed codes", () => {
  const body = failure(unauthorized(), requestId).body;
  for (const code of [
    "UNAUTHORIZED",
    "gateway.unauthorized",
    "gateway..unauthorized",
  ]) {
    assert.throws(
      () => new GatewayError(401, code, "Failure."),
      /Invalid error code/,
    );
    assert.equal(
      errorSchema.safeParse({ ...body, error: { ...body.error, code } })
        .success,
      false,
    );
  }
});

test("HTTP clients reject nonconforming failure envelopes as indeterminate", async () => {
  const client = httpClient(
    gatewayOperations,
    "http://localhost",
    undefined,
    async () =>
      Response.json(
        {
          error: { code: "UNAUTHORIZED", message: "Failure.", details: null },
          requestId,
        },
        { status: 401 },
      ),
  );
  const result = await client.verify({ params: {}, query: {}, body: null });
  assert.equal(result.type, OperationResultType.Indeterminate);
  assert.equal(result.idempotencyKey, undefined);
});
