import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import { temporary } from "../kernel/test-support.ts";
import { gatewayOperations, HEALTHCHECK_OK } from "./contract.ts";
import { HealthStatus } from "../kernel/service.ts";
import { HttpStatus } from "../kernel/http.ts";
import { workerOperations } from "../worker/contract.ts";
import {
  AccessPolicy,
  emptyInput,
  OperationRegistry,
} from "../kernel/operation.ts";
import { emitOpenAPIFiles, openAPIFileNames, writeOpenAPI } from "./openapi.ts";

const PROJECT_PATH_REFERENCE = "./openapi/project/read.yaml#/pathItem";
const HANDWRITTEN_DOCUMENT = "description: operator-owned\n";

test("OpenAPI projection validates service scopes without making the kernel registry depend on the emitter", () => {
  const registry = new OperationRegistry();
  assert.doesNotThrow(() =>
    registry.register(
      { ...gatewayOperations.liveness, service: "../escape" },
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
    ...gatewayOperations.liveness,
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
    ...gatewayOperations.liveness,
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

test("a no-content operation publishes no response content", () => {
  const files = emitOpenAPIFiles([workerOperations.heartbeat]);
  const document = files["openapi/worker/heartbeat.yaml"];
  assert.ok(document && "pathItem" in document);
  const path = document.pathItem as {
    post: { operationId: string; responses: Record<string, unknown> };
  };
  assert.equal(path.post.operationId, workerOperations.heartbeat.id);
  assert.deepEqual(path.post.responses[HttpStatus.NoContent], {
    description: "Completed result",
  });
});

test("the emitter excludes a service operation and a direct operation", () => {
  const routed = {
    ...gatewayOperations.liveness,
    id: "test.routed",
    service: "test",
    path: "/api/test/routed",
  } as const;
  const service = {
    ...routed,
    id: "test.service",
    path: "/api/test/service",
    access: AccessPolicy.Service,
  } as const;
  const direct = {
    ...routed,
    id: "test.direct",
    path: "/api/test/direct",
    access: AccessPolicy.Human,
    direct: true,
  } as const;
  const files = emitOpenAPIFiles([routed, service, direct]);
  assert.deepEqual(Object.keys(files["openapi.yaml"].paths), [routed.path]);
  const names = openAPIFileNames([routed, service, direct]);
  assert.ok(names.includes("openapi/test/routed.yaml"));
  assert.equal(names.includes("openapi/test/service.yaml"), false);
  assert.equal(names.includes("openapi/test/direct.yaml"), false);
});

test("a delivery path publishes no security, an octet-stream body and two empty responses", () => {
  const delivery = {
    ...gatewayOperations.liveness,
    id: "test.receive",
    service: "test",
    method: "POST",
    path: "/hooks/:inbound_id",
    access: AccessPolicy.Delivery,
    delivery: true,
    input: z.strictObject({
      params: z.strictObject({ inbound_id: z.string() }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: z.null(),
    status: HttpStatus.Accepted,
  } as const;
  const files = emitOpenAPIFiles([delivery]);
  assert.deepEqual(Object.keys(files["openapi.yaml"].paths), [
    "/hooks/{inbound_id}",
  ]);
  const document = files["openapi/test/receive.yaml"];
  assert.ok(document && "pathItem" in document);
  const path = document.pathItem as {
    post: {
      "x-access-policy": string;
      security: unknown[];
      requestBody: { content: Record<string, unknown> };
      responses: Record<string, unknown>;
    };
  };
  assert.equal(path.post["x-access-policy"], AccessPolicy.Delivery);
  assert.deepEqual(path.post.security, []);
  assert.deepEqual(Object.keys(path.post.requestBody.content), [
    "application/octet-stream",
  ]);
  assert.deepEqual(path.post.responses[HttpStatus.Accepted], {
    description: "Completed result",
  });
  assert.deepEqual(path.post.responses[HttpStatus.NoContent], {
    description: "Completed result",
  });
});
