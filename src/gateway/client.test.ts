import assert from "node:assert/strict";
import { test } from "node:test";
import { Diagnostic } from "../kernel/errors.ts";
import { packageVersion } from "../kernel/version.ts";
import { gatewayOperations } from "./contract.ts";
import { httpClient, readServerVersion } from "./client.ts";
import { gatewayFixture } from "./test-support.ts";

const VERSION_UNAVAILABLE = "gateway.client.version_unavailable";

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
