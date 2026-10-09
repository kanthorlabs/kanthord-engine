import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { packageVersion } from "../kernel/version.ts";
import { gatewayOperations } from "./contract.ts";
import { httpClient, readServerVersion } from "./client.ts";
import { gatewayFixture } from "./test-support.ts";

const VERSION_UNAVAILABLE = "gateway.client.version_unavailable";

test("verification client preserves JWT business properties and rejects aliases and metadata", async () => {
  const claims = { kind: "human", sub: " ulrich ", name: " Ulrich " };
  const input = { params: {}, query: {}, body: null };
  const client = httpClient(
    gatewayOperations,
    "http://localhost",
    undefined,
    async () => Response.json(claims),
  );
  const result = await client.verify(input);
  assert.ok(result.type === OperationResultType.Completed);
  assert.deepEqual(result.data, claims);

  const invalidResponses = [
    { kind: claims.kind, accountId: claims.sub, name: claims.name },
    { ...claims, accountId: claims.sub },
    { ...claims, iat: 0, exp: 1, jti: "session" },
  ];
  for (let index = 0; index < invalidResponses.length; index++) {
    const invalidClient = httpClient(
      gatewayOperations,
      "http://localhost",
      undefined,
      async () => Response.json(invalidResponses[index]),
    );
    assert.deepEqual(await invalidClient.verify(input), {
      type: OperationResultType.Indeterminate,
      idempotencyKey: undefined,
    });
  }
});

test("server version is the package version served through the OpenAPI operation", async (t) => {
  const fixture = await gatewayFixture(t);
  const client = httpClient(gatewayOperations, fixture.endpoint);
  assert.equal(await readServerVersion(client), packageVersion());
  assert.equal(await readServerVersion(client), packageVersion());
});

test("missing, malformed and unavailable server versions are diagnostics", async () => {
  for (const body of [
    "",
    "info: [",
    "info: {}",
    "info: {version: 1}",
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

test("client joins an endpoint path prefix with the operation path", async () => {
  const input = { params: {}, query: {}, body: null };
  for (const [endpoint, expected] of [
    [
      "https://h.example/s/kanthord",
      "https://h.example/s/kanthord/api/liveness",
    ],
    [
      "https://h.example/s/kanthord/",
      "https://h.example/s/kanthord/api/liveness",
    ],
    ["https://h.example", "https://h.example/api/liveness"],
    ["https://h.example/", "https://h.example/api/liveness"],
  ]) {
    let requested = "";
    const client = httpClient(
      gatewayOperations,
      endpoint!,
      undefined,
      async (url) => {
        requested = String(url);
        return Response.json({ status: "ok", services: {} });
      },
    );
    await client.liveness(input);
    assert.equal(requested, expected);
  }
});

test("client reaches a gateway served under a base path", async (t) => {
  const fixture = await gatewayFixture(t, { basePath: "/s/kanthord" });
  const client = httpClient(
    gatewayOperations,
    `${fixture.endpoint}/s/kanthord`,
  );
  assert.equal(await readServerVersion(client), packageVersion());
});
