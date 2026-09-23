import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import { temporary } from "../kernel/test-support.ts";
import { gatewayOperations, HEALTHCHECK_OK } from "./contract.ts";
import { HealthStatus } from "../kernel/service.ts";
import { workerOperations } from "../worker/contract.ts";
import { emptyInput, OperationRegistry } from "../kernel/operation.ts";
import { emitOpenAPIFiles, writeOpenAPI } from "./openapi.ts";

const PROJECT_PATH_REFERENCE = "./openapi/project/read.yaml#/pathItem";
const HANDWRITTEN_DOCUMENT = "description: operator-owned\n";

test("OpenAPI projection validates service scopes without making the kernel registry depend on the emitter", () => {
  const registry = new OperationRegistry();
  assert.doesNotThrow(() =>
    registry.register(
      { ...gatewayOperations.healthcheck, service: "../escape" },
      () => ({
        status: HEALTHCHECK_OK,
        services: { gateway: { listener: HealthStatus.Healthy } },
      }),
    ),
  );
  assert.throws(
    () => emitOpenAPIFiles(registry.all().map(({ operation }) => operation)),
    /safe name/,
  );
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
    () => emitOpenAPIFiles([{ ...read, service: "../escape" }]),
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

const apiOperations = { ...gatewayOperations, ...workerOperations };
