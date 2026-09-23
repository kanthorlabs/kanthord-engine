import assert from "node:assert/strict";
import { test } from "node:test";
import { HealthRegistry } from "../health.ts";
import { gatewayFixture } from "../test-support.ts";
import { directClient, OperationResultType } from "./client.ts";
import { errorSchema } from "./errors.ts";
import { gatewayOperations } from "./operations.ts";
import { HttpStatus } from "../shared/http.ts";

const UNHEALTHY_ERROR_CODE = "gateway.healthcheck.unhealthy";

const gateway = {
  listener: 200,
  authentication: 200,
  idempotency: 200,
  registry: 200,
  invocation: 200,
};

test("HTTP and direct healthcheck report every registered service and current provider/instance components", async (t) => {
  const health = new HealthRegistry();
  let instances = { "instance-one": 200 };
  health.register("project", () => ({ "llm-primary": 200 }));
  health.register("worker", () => instances);
  const fixture = await gatewayFixture(t, { health });
  const response = await fixture.request("/api/healthcheck");
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body, {
    status: "ok",
    services: {
      gateway,
      project: { "llm-primary": 200 },
      worker: { "instance-one": 200 },
    },
  });
  const client = directClient(gatewayOperations, fixture.gateway.invocation);
  const result = await client.healthcheck({
    params: {},
    query: {},
    body: null,
  });
  assert.equal(result.type, OperationResultType.Completed);
  if (result.type === OperationResultType.Completed)
    assert.deepEqual(result.data, body);
  instances = { "instance-one": 503 };
  const unavailable = await fixture.request("/api/healthcheck");
  assert.equal(unavailable.status, HttpStatus.ServiceUnavailable);
  const failure = errorSchema.parse(await unavailable.json());
  assert.equal(failure.error.code, UNHEALTHY_ERROR_CODE);
  assert.deepEqual(failure.error.details, {
    ...body.services,
    worker: { "instance-one": 503 },
  });
});

test("failed probes preserve healthy siblings, use the shared failure envelope and expose no exception text", async (t) => {
  const health = new HealthRegistry();
  health.register("project", async () => {
    throw new Error("secret provider token");
  });
  health.register("worker", () => ({}));
  health.register("store", () => ({ sqlite: 200 }));
  const fixture = await gatewayFixture(t, { health });
  const response = await fixture.request("/api/healthcheck");
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const body = errorSchema.parse(await response.json());
  assert.equal(body.error.code, UNHEALTHY_ERROR_CODE);
  assert.deepEqual(body.error.details, {
    project: { healthcheck: 503 },
    worker: { healthcheck: 503 },
    store: { sqlite: 200 },
    gateway,
  });
  assert.doesNotMatch(JSON.stringify(body), /secret|token/);
  assert.equal(body.requestId, response.headers.get("x-request-id"));
});

test("a timed-out service returns the complete report rather than blocking the health endpoint", async (t) => {
  const health = new HealthRegistry(20);
  health.register("project", () => new Promise(() => {}));
  const fixture = await gatewayFixture(t, { health });
  const response = await fixture.request("/api/healthcheck");
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  assert.deepEqual(errorSchema.parse(await response.json()).error.details, {
    project: { healthcheck: 503 },
    gateway,
  });
});

test("a closed SQLite database is reported alongside other registered services", async (t) => {
  const fixture = await gatewayFixture(t);
  fixture.gateway.health.register("store", () => ({
    sqlite: fixture.store.healthcheck() ? 200 : 503,
  }));
  fixture.gateway.health.register("worker", () => ({ "instance-one": 200 }));
  fixture.store.close();
  const response = await fixture.request("/api/healthcheck");
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  assert.deepEqual(errorSchema.parse(await response.json()).error.details, {
    gateway: {
      ...gateway,
      authentication: 503,
      idempotency: 503,
      invocation: 503,
    },
    store: { sqlite: 503 },
    worker: { "instance-one": 200 },
  });
});
