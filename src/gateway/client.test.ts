import assert from "node:assert/strict";
import { once } from "node:events";
import { MessageChannel } from "node:worker_threads";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { packageVersion } from "../kernel/version.ts";
import { schedulerOperations, WorkPullKind } from "../scheduler/contract.ts";
import { gatewayOperations } from "./contract.ts";
import { createClient } from "./client-result.ts";
import { httpClient, portCaller, readServerVersion } from "./client.ts";
import { gatewayFixture } from "./test-support.ts";

const VERSION_UNAVAILABLE = "gateway.client.version_unavailable";
const ANSWER_INVALID = "gateway.client.answer_invalid";
const IDEMPOTENCY_KEY = "idempotency_key_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PULL_INPUT = {
  params: {},
  query: {},
  body: {
    resource_identity: "worker:kanthord:test",
    runtime_identity: "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  },
};

test("an expected answer that fails the output schema is a declared failure", async () => {
  const client = httpClient(
    schedulerOperations,
    "http://localhost",
    undefined,
    async () => Response.json({ kind: WorkPullKind.NoWork, future_field: "x" }),
  );
  const result = await client.workPull(PULL_INPUT, {
    idempotencyKey: IDEMPOTENCY_KEY,
  });
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, HttpStatus.OK);
  assert.equal(result.error.error.code, ANSWER_INVALID);
  assert.equal(result.idempotencyKey, IDEMPOTENCY_KEY);
});

test("a transport failure and a truncated answer body stay indeterminate", async () => {
  for (const transport of [
    async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    },
    async () =>
      new Response('{"kind":"claimed","execution":{', {
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    const client = httpClient(
      schedulerOperations,
      "http://localhost",
      undefined,
      transport,
    );
    assert.deepEqual(
      await client.workPull(PULL_INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
      {
        type: OperationResultType.Indeterminate,
        idempotencyKey: IDEMPOTENCY_KEY,
      },
    );
  }
});

test("a closed port answers a new call as indeterminate at once", async () => {
  const { port1, port2 } = new MessageChannel();
  const client = createClient(schedulerOperations, portCaller(port1));
  const closed = once(port1, "close");
  port2.close();
  await closed;
  assert.deepEqual(
    await client.workPull(PULL_INPUT, { idempotencyKey: IDEMPOTENCY_KEY }),
    {
      type: OperationResultType.Indeterminate,
      idempotencyKey: IDEMPOTENCY_KEY,
      closed: true,
    },
  );
});

test("server version is the package version served through the OpenAPI operation", async (t) => {
  const fixture = await gatewayFixture(t);
  const client = httpClient(gatewayOperations, fixture.endpoint);
  assert.equal(await readServerVersion(client), packageVersion());
  assert.equal(await readServerVersion(client), packageVersion());
});

test("missing, malformed and unavailable server versions are diagnostics", async () => {
  for (const body of [
    "info: {version: ''}",
    "info: {version: first, version: second}",
  ]) {
    const client = httpClient(
      gatewayOperations,
      "http://localhost",
      undefined,
      async () => new Response(body),
    );
    const result = await readServerVersion(client);
    assert.ok(result instanceof Diagnostic);
    assert.equal(result.code, VERSION_UNAVAILABLE);
  }
  const client = httpClient(gatewayOperations, "http://127.0.0.1:1");
  const result = await readServerVersion(client);
  assert.ok(result instanceof Diagnostic);
  assert.equal(result.code, VERSION_UNAVAILABLE);
});

test("client reaches a gateway served under a base path", async (t) => {
  const fixture = await gatewayFixture(t, { basePath: "/s/kanthord" });
  const client = httpClient(
    gatewayOperations,
    `${fixture.endpoint}/s/kanthord`,
  );
  assert.equal(await readServerVersion(client), packageVersion());
});
