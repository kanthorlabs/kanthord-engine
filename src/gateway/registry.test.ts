import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import { gatewayFixture, temporary } from "../test-support.ts";
import { apiOperations, gatewayOperations, openapiPath } from "./operations.ts";
import { workerOperations } from "../worker/operations.ts";
import { emptyInput, OperationRegistry, type Operation } from "./registry.ts";
import {
  emitOpenAPIFiles,
  serializeOpenAPIFile,
  writeOpenAPI,
} from "./openapi.ts";

import { HttpStatus } from "../shared/http.ts";

const MAX_OPENAPI_FRAGMENT_LINES = 200;
const PROJECT_PATH_REFERENCE = "./openapi/project/read.yaml#/pathItem";
const HANDWRITTEN_DOCUMENT = "description: operator-owned\n";

test("registry rejects undeclared access policies, duplicates, versioned paths and late registration", () => {
  const registry = new OperationRegistry();
  assert.throws(
    () =>
      registry.register(
        {
          ...gatewayOperations.healthcheck,
          access: undefined,
        } as unknown as Operation,
        () => ({}),
      ),
    /access policy/,
  );
  assert.throws(
    () =>
      registry.register(
        { ...gatewayOperations.healthcheck, path: "/api/v1/healthcheck" },
        () => {
          throw new Error();
        },
      ),
    /unversioned/,
  );
  assert.throws(
    () =>
      registry.register(
        { ...gatewayOperations.healthcheck, mutation: true },
        () => {
          throw new Error();
        },
      ),
    /verified caller/,
  );
  registry.register(gatewayOperations.healthcheck, () => ({
    status: "ok" as const,
    services: { gateway: { listener: 200 as const } },
  }));
  assert.throws(
    () =>
      registry.register(gatewayOperations.healthcheck, () => {
        throw new Error();
      }),
    /Duplicate/,
  );
  registry.seal();
  assert.throws(
    () =>
      registry.register(workerOperations.register, () => {
        throw new Error();
      }),
    /closed/,
  );
});

test("published OpenAPI validates, matches the registry exactly, and describes real responses", async (t) => {
  const files = emitOpenAPIFiles(Object.values(apiOperations));
  const emitted = files["openapi.yaml"];
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
    assert.ok(
      content.split("\n").length <= MAX_OPENAPI_FRAGMENT_LINES,
      `${file} must stay small enough to review as one scope`,
    );
  }
  const resolved = await SwaggerParser.validate(openapiPath());
  const fixture = await gatewayFixture(t);
  assert.deepEqual(
    Object.keys(fixture.gateway.registry.openapi().paths).sort(),
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

test("OpenAPI scopes isolate services and keep methods sharing a path in one referenced path item", async (t) => {
  const root = temporary(t);
  const read = {
    ...gatewayOperations.healthcheck,
    id: "project.read",
    service: "project",
    path: "/api/projects/:projectId",
    access: "human",
    input: emptyInput.extend({
      params: z.strictObject({ projectId: z.string() }),
    }),
    output: z.strictObject({ projectId: z.string() }),
  } as const;
  const update = {
    ...read,
    id: "project.update",
    method: "PUT",
    mutation: true,
  } as const;
  const mission = {
    ...gatewayOperations.healthcheck,
    id: "mission.read",
    service: "mission",
    path: "/api/mission",
  } as const;
  const operations = [...Object.values(apiOperations), read, update, mission];
  const registry = new OperationRegistry();
  registry.register(read, () => ({ projectId: "project" }));
  assert.throws(
    () =>
      registry.register(
        { ...update, id: "mission.update", service: "mission" },
        () => ({ projectId: "project" }),
      ),
    /same service/,
  );
  assert.throws(
    () =>
      registry.register({ ...read, service: "../escape" }, () => ({
        projectId: "project",
      })),
    /safe name/,
  );
  writeOpenAPI(operations, root);
  const files = emitOpenAPIFiles(operations);
  assert.deepEqual(emitOpenAPIFiles([...operations].reverse()), files);
  assert.equal(
    files["openapi.yaml"].paths["/api/projects/{projectId}"]?.$ref,
    PROJECT_PATH_REFERENCE,
  );
  const project = readFileSync(join(root, "openapi/project/read.yaml"), "utf8");
  assert.match(project, /project.read/);
  assert.match(project, /project.update/);
  assert.doesNotMatch(project, /mission\.|gateway\./);
  assert.match(project, /\.\.\/shared\/components.yaml/);
  const resolved = await SwaggerParser.validate(join(root, "openapi.yaml"));
  assert.equal(
    resolved.paths?.["/api/projects/{projectId}"]?.get?.operationId,
    read.id,
  );
  assert.equal(
    resolved.paths?.["/api/projects/{projectId}"]?.put?.operationId,
    update.id,
  );
  writeFileSync(
    join(root, "openapi/project/handwritten.yaml"),
    HANDWRITTEN_DOCUMENT,
  );
  writeOpenAPI(Object.values(apiOperations), root);
  assert.equal(existsSync(join(root, "openapi/project/read.yaml")), false);
  assert.equal(existsSync(join(root, "openapi/mission/read.yaml")), false);
  assert.equal(
    readFileSync(join(root, "openapi/project/handwritten.yaml"), "utf8"),
    HANDWRITTEN_DOCUMENT,
  );
  await SwaggerParser.validate(join(root, "openapi.yaml"));
});
