import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { gatewayFixture } from "./test-support.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { custodyOperations } from "../../custody/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import {
  openapiPath,
  emitOpenAPI,
  emitOpenAPIFiles,
  serializeOpenAPIFile,
} from "../../gateway/local.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { isObject } from "../../kernel/values.ts";
const MAX_OPENAPI_FRAGMENT_LINES = 200;
const CREDENTIAL_COLLECTION_FRAGMENT = "openapi/credential/create.yaml";
const CREDENTIAL_COLLECTION_MAX_LINES = 300;
const apiOperations = [
  ...Object.values(gatewayOperations),
  ...Object.values(custodyOperations),
  ...Object.values(workerOperations),
];
test("published OpenAPI validates, matches the registry exactly, and describes real responses", async (t) => {
  const files = emitOpenAPIFiles(apiOperations);
  const emitted = files["openapi.yaml"];
  const custodyPaths = new Set(
    Object.values(custodyOperations).map(({ path }) =>
      path.replace(/:([^/]+)/g, "{$1}"),
    ),
  );
  for (const path of custodyPaths) assert.ok(path in emitted.paths, path);
  const root = dirname(openapiPath());
  const stored = readFileSync(openapiPath(), "utf8");
  const fragments = readdirSync(join(root, "openapi"), { recursive: true })
    .filter((name) => String(name).endsWith(".yaml"))
    .map((name) => `openapi/${name}`);
  assert.deepEqual(
    ["openapi.yaml", ...fragments].sort(),
    Object.keys(files).sort(),
  );
  for (const [file, document] of Object.entries(files)) {
    const content = readFileSync(join(root, file), "utf8");
    assert.equal(content, serializeOpenAPIFile(document), file);
    let maxLines = MAX_OPENAPI_FRAGMENT_LINES;
    if (file === CREDENTIAL_COLLECTION_FRAGMENT) {
      assert.ok("pathItem" in document);
      assert.ok(isObject(document.pathItem));
      assert.deepEqual(
        Object.keys(document.pathItem).sort(),
        [
          custodyOperations.create.method.toLowerCase(),
          custodyOperations.list.method.toLowerCase(),
        ].sort(),
      );
      maxLines = CREDENTIAL_COLLECTION_MAX_LINES;
    }
    assert.ok(
      content.split("\n").length <= maxLines,
      `${file} must stay small enough to review as one scope`,
    );
  }
  const resolved = await SwaggerParser.validate(openapiPath());
  for (const operation of Object.values(custodyOperations)) {
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    const method = operation.method.toLowerCase() as "get" | "post" | "put";
    assert.equal(resolved.paths?.[path]?.[method]?.operationId, operation.id);
  }
  const fixture = await gatewayFixture(t);
  assert.deepEqual(
    Object.keys(
      emitOpenAPI(
        fixture.gateway.registry.all().map(({ operation }) => operation),
      ).paths,
    ).sort(),
    Object.keys(emitted.paths).sort(),
  );
  const health = await fixture.request(gatewayOperations.healthcheck.path);
  gatewayOperations.healthcheck.output.parse(await health.json());
  const published = await fixture.request("/api/openapi.yaml");
  assert.equal(published.status, HttpStatus.OK);
  assert.match(published.headers.get("content-type")!, /application\/yaml/);
  assert.equal(await published.text(), stored);
  for (const file of fragments) {
    const response = await fixture.request(`/api/${file}`);
    assert.equal(response.status, HttpStatus.OK, file);
    assert.match(response.headers.get("content-type")!, /application\/yaml/);
    assert.equal(await response.text(), readFileSync(join(root, file), "utf8"));
  }
  // Resolve external references over HTTP as an actual consumer would.
  const remote = await SwaggerParser.validate(
    `${fixture.endpoint}/api/openapi.yaml`,
    { resolve: { http: { safeUrlResolver: false } } },
  );
  assert.deepEqual(
    Object.keys(remote.paths ?? {}).sort(),
    Object.keys(resolved.paths ?? {}).sort(),
  );
  assert.equal(resolved.paths?.["/api/auth/login"], undefined);
  assert.equal(existsSync(join(root, "openapi/gateway/login.yaml")), false);
  assert.equal(resolved.paths?.["/api/auth/register"], undefined);
  assert.equal(existsSync(join(root, "openapi/gateway/register.yaml")), false);
  assert.equal(
    resolved.paths?.["/api/worker/register"]?.post?.operationId,
    workerOperations.register.id,
  );
  const authResponse = resolved.paths?.["/api/worker/register"]?.post
    ?.responses["200"] as unknown as {
    content: {
      "application/json": {
        schema: { properties: { runtimeIdentity: { type: string } } };
      };
    };
  };
  const STRING_SCHEMA_TYPE = "string";
  assert.equal(
    authResponse.content["application/json"].schema.properties.runtimeIdentity
      .type,
    STRING_SCHEMA_TYPE,
  );
  assert.equal(
    "requestBody" in resolved.paths!["/api/worker/register"]!.post!,
    false,
  );
  assert.deepEqual(resolved.paths?.["/api/worker/register"]?.post?.security, [
    { bearerAuth: [] },
  ]);
  for (const path of [
    "/api/openapi/shared/missing.yaml",
    "/api/openapi/unknown/login.yaml",
    "/api/openapi/gateway/package.json",
    "/api/openapi/gateway/%2e%2e%2f%2e%2e%2fpackage.json",
  ]) {
    const response = await fixture.request(path);
    assert.ok([400, 404].includes(response.status), path);
  }
});
