import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { ulid } from "ulid";
import {
  AccessPolicy,
  emptyInput,
  OperationLifetime,
  OperationRegistry,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { errorSchema } from "../kernel/errors.ts";
import { fakeLookups, gatewayFixture } from "./test-support.ts";
import { generateWorkerJWT } from "./auth/jwt.ts";

const FOREIGN_HOST = "kanthord:31415";
const HOST_NOT_ALLOWED = "gateway.http.host_not_allowed";
const INSTANCE_NAME = "laptop";
const NO_STORE = "no-store";
const BASE_PATH = "/kanthord";

function read(id: string, path: string, access: AccessPolicy) {
  return {
    id,
    service: "test",
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    method: "GET",
    path,
    access,
    timeoutMs: 30000,
    mutation: false,
    input: emptyInput,
    output: z.strictObject({ ok: z.boolean() }),
    status: 200,
    description: "Answer a host rule test.",
  } as const satisfies Operation;
}

const routes = {
  human: read("test.human", "/api/test/human", AccessPolicy.Human),
  client: read("test.client", "/api/test/client", AccessPolicy.Client),
  worker: read("test.worker", "/api/test/worker", AccessPolicy.Worker),
  mixed: read("test.mixed", "/api/test/mixed", AccessPolicy.HumanOrWorker),
};

async function hostFixture(
  t: Parameters<typeof gatewayFixture>[0],
  basePath?: string,
) {
  const registry = new OperationRegistry();
  for (const operation of Object.values(routes))
    registry.register(operation, () => ({ ok: true }));
  const instanceId = `worker_instance_${ulid()}`;
  const lookups = {
    ...fakeLookups(),
    instances: {
      liveInstance: (id: string) =>
        id === instanceId
          ? { id, name: INSTANCE_NAME, worker: "coder@1" }
          : null,
      holdConnection: () => true,
    },
  };
  const fixture = await gatewayFixture(t, { registry, lookups, basePath });
  const workerToken = (
    await generateWorkerJWT(
      fixture.config.master_key,
      fixture.config.gateway.auth.version,
      { instanceId, name: INSTANCE_NAME },
    )
  ).token;
  const request = (path: string, token?: string) =>
    fixture.gateway.app.request(path, {
      headers: {
        Host: FOREIGN_HOST,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  const hostRefused = async (response: Response) =>
    response.status === HttpStatus.Forbidden &&
    errorSchema.parse(await response.json()).error.code === HOST_NOT_ALLOWED;
  return { fixture, workerToken, request, hostRefused };
}

test("a public, client or worker route skips the host check", async (t) => {
  const { request, hostRefused, workerToken } = await hostFixture(t);
  assert.equal((await request("/api/liveness")).status, HttpStatus.OK);
  assert.equal(await hostRefused(await request(routes.client.path)), false);
  const worker = await request(routes.worker.path, workerToken);
  assert.equal(worker.status, HttpStatus.OK);
});

test("under a base path a prefixed public route skips the host check and an unprefixed path keeps it", async (t) => {
  const { request, hostRefused } = await hostFixture(t, BASE_PATH);
  assert.equal(
    (await request(`${BASE_PATH}/api/liveness`)).status,
    HttpStatus.OK,
  );
  assert.ok(await hostRefused(await request("/api/liveness")));
});

test("a human route and a request that matches no route keep the host check", async (t) => {
  const { request, hostRefused, fixture } = await hostFixture(t);
  assert.ok(await hostRefused(await request(routes.human.path, fixture.token)));
  assert.ok(await hostRefused(await request("/api/test/absent")));
});

test("a human_or_worker route skips the host check only for a worker bearer", async (t) => {
  const { request, hostRefused, fixture, workerToken } = await hostFixture(t);
  assert.equal(
    (await request(routes.mixed.path, workerToken)).status,
    HttpStatus.OK,
  );
  assert.ok(await hostRefused(await request(routes.mixed.path, fixture.token)));
  assert.ok(await hostRefused(await request(routes.mixed.path)));
});

test("a secret answer carries Cache-Control no-store", async (t) => {
  const registry = new OperationRegistry();
  const secret = {
    ...read("test.secret", "/api/test/secret", AccessPolicy.Human),
    secret: true,
  } as const satisfies Operation;
  registry.register(secret, () => ({ ok: true }));
  registry.register(routes.human, () => ({ ok: true }));
  const fixture = await gatewayFixture(t, { registry });
  const headers = { Authorization: `Bearer ${fixture.token}` };
  const answer = await fixture.request(secret.path, { headers });
  assert.equal(answer.status, HttpStatus.OK);
  assert.equal(answer.headers.get("cache-control"), NO_STORE);
  const plain = await fixture.request(routes.human.path, { headers });
  assert.equal(plain.headers.get("cache-control"), null);
});
