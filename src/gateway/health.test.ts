import assert from "node:assert/strict";
import { test } from "node:test";
import { HealthRegistry } from "../kernel/health.ts";
import {
  fakeLookups,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";
import { errorSchema } from "../kernel/errors.ts";
import { gatewayOperations, OWNER_PROJECT } from "./contract.ts";
import { HttpStatus } from "../kernel/http.ts";

const UNHEALTHY_ERROR_CODE = "gateway.liveness.unhealthy";
const UNAUTHORIZED_ERROR_CODE = "gateway.authentication.unauthorized";
const INVENTORY_ERROR_CODE = "gateway.healthcheck.inventory_failed";

const gateway = {
  listener: 200,
  authentication: 200,
  idempotency: 200,
  registry: 200,
  invocation: 200,
};

test("failed probes preserve healthy siblings, use the shared failure envelope and expose no exception text", async (t) => {
  const health = new HealthRegistry();
  health.register("project", async () => {
    throw new Error("secret provider token");
  });
  health.register("worker", () => ({}));
  health.register("store", () => ({ sqlite: 200 }));
  const fixture = await gatewayFixture(t, { health });
  const response = await fixture.request("/api/liveness");
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
  assert.equal(body.request_id, response.headers.get("x-request-id"));
});

test("resource healthcheck requires a human and returns four empty owners", async (t) => {
  const fixture = await gatewayFixture(t, { lookups: fakeLookups() });
  const anonymous = await fixture.request(gatewayOperations.healthcheck.path);
  assert.equal(anonymous.status, HttpStatus.Unauthorized);
  assert.equal(
    errorSchema.parse(await anonymous.json()).error.code,
    UNAUTHORIZED_ERROR_CODE,
  );
  const machineToken = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const machine = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${machineToken}` },
  });
  assert.equal(machine.status, HttpStatus.Unauthorized);
  assert.equal(
    errorSchema.parse(await machine.json()).error.code,
    UNAUTHORIZED_ERROR_CODE,
  );
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(
    gatewayOperations.healthcheck.output.parse(await response.json()),
    {
      services: {
        project: { global: {}, projects: {} },
        intake: { global: {}, projects: {} },
        worker: { global: {}, projects: {} },
      },
      shared: {
        llm: { global: {}, projects: {} },
        repository: { global: {}, projects: {} },
        storage: { global: {}, projects: {} },
        agent: { global: {}, projects: {} },
      },
    },
  );
});

test("resource healthcheck reports missing owners through the shared 503 envelope", async (t) => {
  const fixture = await gatewayFixture(t, {
    collect: () => ({ entries: [], missing_inventories: [OWNER_PROJECT] }),
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const body = errorSchema.parse(await response.json());
  assert.equal(body.error.code, INVENTORY_ERROR_CODE);
  assert.deepEqual(body.error.details, {
    missing_inventories: [OWNER_PROJECT],
  });
});
