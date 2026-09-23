import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { testClient } from "hono/testing";
import { gatewayFixture, domainHealth } from "./test-support.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { workerOperations } from "../../worker/contract.ts";
const ALLOWED_ORIGIN = "https://allowed.example";
const ExpectedErrorCode = {
  RouteNotFound: "gateway.routing.not_found",
  HostNotAllowed: "gateway.http.host_not_allowed",
  BodyTooLarge: "gateway.request.body_too_large",
} as const;
test("real listener serves unversioned health, applies host/origin policy and uses one failure envelope", async (t) => {
  const fixture = await gatewayFixture(t);
  fixture.config.gateway.allowedOrigins.push("https://allowed.example");
  const response = await fixture.request("/api/healthcheck");
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), {
    status: "ok",
    services: {
      ...domainHealth,
      gateway: {
        listener: 200,
        authentication: 200,
        idempotency: 200,
        registry: 200,
        invocation: 200,
      },
    },
  });
  assert.match(
    response.headers.get("x-request-id")!,
    /^request_[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  );
  for (const path of [
    "/healthcheck",
    "/healthz",
    "/api/v1/healthcheck",
    "/auth/login",
    "/missing",
  ]) {
    const missing = await fixture.request(path);
    assert.equal(missing.status, HttpStatus.NotFound);
    assert.equal(
      errorSchema.parse(await missing.json()).error.code,
      ExpectedErrorCode.RouteNotFound,
    );
  }
  const forbidden = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const request = httpRequest(
        fixture.endpoint + "/api/healthcheck",
        { headers: { Host: "evil.example", "X-Forwarded-Host": "localhost" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode!, body }),
          );
        },
      );
      request.on("error", reject);
      request.end();
    },
  );
  assert.equal(forbidden.status, HttpStatus.Forbidden);
  assert.equal(
    errorSchema.parse(JSON.parse(forbidden.body)).error.code,
    ExpectedErrorCode.HostNotAllowed,
  );
  const preflight = await fixture.request("/api/worker/register", {
    method: "OPTIONS",
    headers: {
      Origin: "https://allowed.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "Content-Type,Idempotency-Key",
    },
  });
  assert.equal(preflight.status, HttpStatus.NoContent);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    ALLOWED_ORIGIN,
  );
  assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
  const untrusted = await fixture.request("/api/healthcheck", {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(untrusted.headers.get("access-control-allow-origin"), null);
  const client = testClient(fixture.gateway.app) as unknown as {
    api: {
      healthcheck: {
        $get: (input: object, options: object) => Promise<Response>;
      };
    };
  };
  assert.equal(
    (await client.api.healthcheck.$get({}, { headers: { Host: "localhost" } }))
      .status,
    HttpStatus.OK,
  );
});

test("body limits cover declared sizes and streaming auth bodies; unexpected registration bodies are rejected", async (t) => {
  const fixture = await gatewayFixture(t);
  const tooLarge = await new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      fixture.endpoint + "/api/worker/register",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": 41 * 1024,
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode!);
      },
    );
    request.on("error", reject);
    request.end("x");
  });
  assert.equal(tooLarge, HttpStatus.PayloadTooLarge);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(41 * 1024));
      controller.close();
    },
  });
  const streamed = await fixture.request("/api/worker/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    duplex: "half",
  } as RequestInit);
  assert.equal(streamed.status, HttpStatus.PayloadTooLarge);
  assert.equal(
    errorSchema.parse(await streamed.json()).error.code,
    ExpectedErrorCode.BodyTooLarge,
  );
  const duplicate = await fixture.request("/api/worker/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"binding":"unexpected"}',
  });
  assert.equal(duplicate.status, HttpStatus.BadRequest);
  assert.doesNotMatch(await duplicate.text(), /secret-marker/);
});

test("unconfigured worker bindings refuse machine authentication", async (t) => {
  const fixture = await gatewayFixture(t);
  const token = await fixture.machineToken("binding");
  const result = await httpClient(
    workerOperations,
    fixture.endpoint,
    token,
  ).register({
    params: {},
    query: {},
    body: null,
  });
  assert.equal(result.type, OperationResultType.Failure);
  if (result.type === OperationResultType.Failure)
    assert.equal(result.status, HttpStatus.Unauthorized);
});
