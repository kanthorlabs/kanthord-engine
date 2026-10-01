import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { gatewayFixture } from "./test-support.ts";
import { gatewayOperations, HEALTHCHECK_OK } from "../../gateway/contract.ts";
import { custodyOperations } from "../../custody/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  MISSION_INITIAL_VERSION,
  NodeKind,
  missionOperations,
  missionSchema,
} from "../../mission/contract.ts";
import {
  openapiPath,
  emitOpenAPI,
  emitOpenAPIFiles,
  serializeOpenAPIFile,
} from "../../gateway/local.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { AccessPolicy } from "../../kernel/operation.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { isObject, isString } from "../../kernel/values.ts";
const OPENAPI_FRAGMENT_SOFT_LIMIT_LINES = 500;

test("published heartbeat projection names its operation and carries no 204 content", () => {
  const fragment = readFileSync(
    join(dirname(openapiPath()), "openapi/worker/heartbeat.yaml"),
    "utf8",
  );
  assert.match(fragment, /operationId: worker\.heartbeat/);
  assert.match(fragment, /"204":\n\s+description: Completed result/);
  assert.doesNotMatch(
    fragment,
    /"204":\n\s+description: Completed result\n\s+content:/,
  );
});
const MISSION_BLOCKED_CONTEXT_FRAGMENT_EXCEPTIONS = [
  ["node.unblock", "mission.node.unblock", "properties", "node"],
  ["node.override", "mission.node.override", "properties", "node"],
  ["node.block", "mission.node.block", "properties", "node"],
  ["node.discard", "mission.node.discard", "properties", "node"],
  ["node.ready", "mission.node.ready", "properties", "node"],
  ["node.resume", "mission.node.resume", "properties", "node"],
  ["node.pause", "mission.node.pause", "properties", "node"],
  ["node.create", "mission.node.list", "properties", "items", "items"],
  ["node.get", "mission.node.get"],
  ["node.priority.set", "mission.node.priority.set"],
  [
    "node.rebind",
    "mission.node.rebind",
    "properties",
    "skipped",
    "items",
    "properties",
    "node",
  ],
] as const;
const ARRAY_SCHEMA_TYPE = "array";
const NULL_SCHEMA_TYPE = "null";
const STRING_SCHEMA_TYPE = "string";
const NONEMPTY_STRING_MIN_LENGTH = 1;
const OPERATION_PREFIXES = [
  "gateway.",
  "credential.",
  "scheduler.",
  "worker.",
  "project.",
  "mission.",
];
const BEARER_SECURITY = [{ bearerAuth: [] }];
const LIVENESS_PATH = "/api/liveness";
const HEALTHCHECK_PATH = "/api/healthcheck";
const LIVENESS_TIMEOUT_MS = 30000;
const HEALTHCHECK_TIMEOUT_MS = 120000;
type ResolvedSchema = {
  required?: string[];
  properties: Record<string, ResolvedSchema>;
  additionalProperties?: ResolvedSchema | boolean;
  enum?: unknown[];
  anyOf?: ResolvedSchema[];
  const?: unknown;
  type?: string;
  minLength?: number;
};
type ResolvedJsonResponse = {
  content: { "application/json": { schema: ResolvedSchema } };
};
type ResolvedOperation = {
  operationId?: string;
  "x-access-policy"?: string;
  "x-timeout-ms"?: number;
  security?: unknown;
};
const MISSION_GET_PATH = "/api/mission/project/{projectId}";
const MISSION_PROJECT_NAME = "openapi-mission";
const apiOperations = [
  ...Object.values(gatewayOperations),
  ...Object.values(custodyOperations),
  ...Object.values(workerOperations),
  ...Object.values(schedulerOperations),
  ...Object.values(projectOperations),
  ...Object.values(missionOperations),
];
function assertBlockedNode(schema: unknown): void {
  assert.ok(
    isObject(schema) && "oneOf" in schema && Array.isArray(schema.oneOf),
  );
  const variants = schema.oneOf as ResolvedSchema[];
  assert.deepEqual(
    variants.map((variant) => variant.properties.kind?.const),
    [NodeKind.Initiative, NodeKind.Objective, NodeKind.Task],
  );
  for (const variant of variants) {
    const context = variant.properties.blockedContext;
    if (variant.properties.kind?.const === NodeKind.Task) {
      assert.equal(context, undefined);
      continue;
    }
    assert.ok(context);
    assert.deepEqual(context.required, ["outcome", "requests"]);
    assert.equal(context.properties.requests?.type, ARRAY_SCHEMA_TYPE);
    assert.deepEqual(
      Object.keys(context.properties.outcome!.properties).sort(),
      [
        "assessmentId",
        "attempt",
        "closingEvent",
        "createdAt",
        "evidenceIds",
        "id",
        "nodeId",
        "nodeRevision",
        "result",
      ],
    );
  }
}

test("named Mission fragment size exceptions retain the complete blocked context", () => {
  const files = emitOpenAPIFiles(apiOperations);
  for (const [
    fragment,
    operationId,
    ...path
  ] of MISSION_BLOCKED_CONTEXT_FRAGMENT_EXCEPTIONS) {
    const file = files[`openapi/mission/${fragment}.yaml`];
    assert.ok(file);
    let schema: unknown = file;
    for (const key of [
      "components",
      "schemas",
      `${operationId}.Output`,
      ...path,
    ]) {
      assert.ok(isObject(schema));
      schema = (schema as Record<string, unknown>)[key];
    }
    assertBlockedNode(schema);
  }
});
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
    const lineCount = content.trimEnd().split("\n").length;
    if (lineCount > OPENAPI_FRAGMENT_SOFT_LIMIT_LINES)
      t.diagnostic(
        `${file} has ${lineCount} lines (soft limit: ${OPENAPI_FRAGMENT_SOFT_LIMIT_LINES})`,
      );
  }
  const resolved = await SwaggerParser.validate(openapiPath());
  const dereferenced = await SwaggerParser.dereference(openapiPath());
  const emittedIds = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path).flatMap((value) =>
      isObject(value) && "operationId" in value && isString(value.operationId)
        ? [value.operationId]
        : [],
    ),
  );
  assert.ok(
    emittedIds.every((id) =>
      OPERATION_PREFIXES.some((prefix) => id.startsWith(prefix)),
    ),
  );
  assert.equal(new Set(emittedIds).size, emittedIds.length);
  assert.deepEqual(
    [...new Set(emittedIds)].sort(),
    [...new Set(apiOperations.map(({ id }) => id))].sort(),
  );
  assert.equal(gatewayOperations.liveness.path, LIVENESS_PATH);
  assert.equal(gatewayOperations.healthcheck.path, HEALTHCHECK_PATH);
  assert.equal(gatewayOperations.liveness.timeoutMs, LIVENESS_TIMEOUT_MS);
  assert.equal(gatewayOperations.healthcheck.timeoutMs, HEALTHCHECK_TIMEOUT_MS);
  const liveness = resolved.paths?.[LIVENESS_PATH]?.get as
    ResolvedOperation | undefined;
  const healthcheck = resolved.paths?.[HEALTHCHECK_PATH]?.get as
    ResolvedOperation | undefined;
  assert.equal(liveness?.operationId, gatewayOperations.liveness.id);
  assert.equal(liveness?.["x-access-policy"], AccessPolicy.Public);
  assert.equal(
    liveness?.["x-timeout-ms"],
    gatewayOperations.liveness.timeoutMs,
  );
  assert.deepEqual(liveness?.security, []);
  assert.equal(healthcheck?.operationId, gatewayOperations.healthcheck.id);
  assert.equal(healthcheck?.["x-access-policy"], AccessPolicy.Human);
  assert.equal(
    resolved.paths?.["/api/worker/instance/{runtimeIdentity}"]?.delete
      ?.operationId,
    workerOperations["instance.deregister"].id,
  );
  for (const operation of [
    workerOperations["catalog.list"],
    workerOperations["catalog.get"],
  ]) {
    const published = resolved.paths?.[
      operation.path.replace(":workerName", "{workerName}")
    ]?.get as ResolvedOperation | undefined;
    assert.equal(published?.operationId, operation.id);
    assert.equal(published?.["x-access-policy"], AccessPolicy.Human);
    assert.deepEqual(published?.security, BEARER_SECURITY);
  }
  assert.equal(
    healthcheck?.["x-timeout-ms"],
    gatewayOperations.healthcheck.timeoutMs,
  );
  assert.deepEqual(healthcheck?.security, BEARER_SECURITY);
  const healthResponse = dereferenced.paths?.[
    gatewayOperations.healthcheck.path
  ]?.get?.responses[HttpStatus.OK] as unknown as ResolvedJsonResponse;
  const healthSchema = healthResponse.content["application/json"].schema;
  assert.deepEqual(healthSchema.required?.sort(), ["services", "shared"]);
  assert.deepEqual(Object.keys(healthSchema.properties).sort(), [
    "services",
    "shared",
  ]);
  const services = healthSchema.properties.services!;
  const shared = healthSchema.properties.shared!;
  assert.deepEqual(Object.keys(services.properties).sort(), [
    "intake",
    "project",
    "worker",
  ]);
  assert.deepEqual(Object.keys(shared.properties), ["custody"]);
  for (const owner of [
    ...Object.values(services.properties),
    ...Object.values(shared.properties),
  ]) {
    assert.deepEqual(Object.keys(owner.properties).sort(), [
      "global",
      "projects",
    ]);
    const entry = owner.properties.global!.additionalProperties;
    assert.ok(entry && isObject(entry));
    assert.deepEqual(Object.keys(entry.properties).sort(), [
      "capability",
      "status",
    ]);
    assert.deepEqual(entry.properties.status!.enum, [
      ResourceStatus.Healthy,
      ResourceStatus.Unhealthy,
      ResourceStatus.Unknown,
    ]);
    assert.equal(entry.properties.capability?.type, STRING_SCHEMA_TYPE);
    assert.equal(
      entry.properties.capability?.minLength,
      NONEMPTY_STRING_MIN_LENGTH,
    );
    const projectMap = owner.properties.projects!.additionalProperties;
    assert.ok(projectMap && isObject(projectMap));
    assert.deepEqual(projectMap.additionalProperties, entry);
  }
  const livenessResponse = dereferenced.paths?.[gatewayOperations.liveness.path]
    ?.get?.responses[HttpStatus.OK] as unknown as ResolvedJsonResponse;
  const livenessSchema = livenessResponse.content["application/json"].schema;
  assert.deepEqual(Object.keys(livenessSchema.properties).sort(), [
    "services",
    "status",
  ]);
  assert.deepEqual(livenessSchema.required?.sort(), ["services", "status"]);
  assert.equal(livenessSchema.properties.status!.const, HEALTHCHECK_OK);
  const componentMap = livenessSchema.properties.services!.additionalProperties;
  assert.ok(componentMap && isObject(componentMap));
  const componentStatus = componentMap.additionalProperties;
  assert.ok(componentStatus && isObject(componentStatus));
  assert.deepEqual(
    componentStatus.anyOf?.map((schema) => schema.const),
    [HealthStatus.Healthy, HealthStatus.Unavailable],
  );
  assert.equal(
    resolved.paths?.["/api/project"]?.post?.operationId,
    projectOperations.create.id,
  );
  assert.equal(
    resolved.paths?.["/api/project/{projectId}/binding-set"]?.put?.operationId,
    projectOperations["bindingSet.write"].id,
  );
  const emittedWorkerIds = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path).map(
      (operation) => (operation as { operationId?: string }).operationId,
    ),
  );
  for (const id of [
    "worker.agent.enablement.list",
    "worker.agent.enablement.get",
    "worker.agent.enablement.put",
    "worker.agent.enablement.enable",
    "worker.agent.enablement.disable",
    "worker.agent.enablement.remove",
    "worker.agent.enablement.provider.add",
    "worker.agent.enablement.provider.remove",
  ])
    assert.ok(emittedWorkerIds.includes(id), id);
  for (const operation of Object.values(custodyOperations)) {
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    const method = operation.method.toLowerCase() as "get" | "post" | "put";
    assert.equal(resolved.paths?.[path]?.[method]?.operationId, operation.id);
  }
  for (const operation of Object.values(schedulerOperations)) {
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    assert.equal(resolved.paths?.[path]?.get?.operationId, operation.id);
  }
  const queueListPath = schedulerOperations.queueList.path.replace(
    /:([^/]+)/g,
    "{$1}",
  );
  const queueListResponse = resolved.paths?.[queueListPath]?.get?.responses[
    HttpStatus.OK
  ] as unknown as {
    content: {
      "application/json": {
        schema: {
          properties: {
            items: { type: string };
            nextCursor: { anyOf: { type: string }[] };
          };
        };
      };
    };
  };
  const queueListProperties =
    queueListResponse.content["application/json"].schema.properties;
  assert.equal(queueListProperties.items.type, ARRAY_SCHEMA_TYPE);
  assert.ok(
    queueListProperties.nextCursor.anyOf.some(
      (schema) => schema.type === NULL_SCHEMA_TYPE,
    ),
  );
  const queuePeekPath = schedulerOperations.queuePeek.path.replace(
    /:([^/]+)/g,
    "{$1}",
  );
  const queuePeekResponse = resolved.paths?.[queuePeekPath]?.get?.responses[
    HttpStatus.OK
  ] as unknown as {
    content: {
      "application/json": {
        schema: { properties: { job: { anyOf: { type: string }[] } } };
      };
    };
  };
  assert.ok(
    queuePeekResponse.content[
      "application/json"
    ].schema.properties.job.anyOf.some(
      (schema) => schema.type === NULL_SCHEMA_TYPE,
    ),
  );
  assert.equal(
    resolved.paths?.[MISSION_GET_PATH]?.get?.operationId,
    missionOperations.get.id,
  );
  const missionResponse = resolved.paths?.[MISSION_GET_PATH]?.get?.responses[
    HttpStatus.OK
  ] as unknown as {
    content: {
      "application/json": {
        schema: { properties: Record<string, { type: string }> };
      };
    };
  };
  const missionProperties =
    missionResponse.content["application/json"].schema.properties;
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(missionProperties).map(([name, schema]) => [
        name,
        schema.type,
      ]),
    ),
    { id: "string", projectId: "string", version: "integer" },
  );
  const fixture = await gatewayFixture(t);
  for (const name of [
    "attempt.list",
    "attempt.get",
    "externalAction.list",
    "externalAction.get",
    "assessment.list",
    "assessment.get",
    "outcome.list",
    "outcome.get",
  ] as const) {
    const operation = missionOperations[name];
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    assert.equal(resolved.paths?.[path]?.get?.operationId, operation.id);
    if (!name.endsWith(".list")) continue;
    const response = resolved.paths?.[path]?.get?.responses[
      HttpStatus.OK
    ] as unknown as {
      content: {
        "application/json": { schema: { properties: Record<string, unknown> } };
      };
    };
    assert.deepEqual(
      Object.keys(
        response.content["application/json"].schema.properties,
      ).sort(),
      ["items", "nextCursor"],
    );
  }
  assert.deepEqual(
    emitOpenAPI(
      fixture.gateway.registry.all().map(({ operation }) => operation),
    ),
    emitOpenAPI(apiOperations),
  );
  const headers = {
    Authorization: `Bearer ${fixture.token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": ulid(),
  };
  const created = await fixture.request(projectOperations.create.path, {
    method: projectOperations.create.method,
    headers,
    body: JSON.stringify({ name: MISSION_PROJECT_NAME }),
  });
  assert.equal(created.status, HttpStatus.OK);
  const project = projectOperations.create.output.parse(await created.json());
  const response = await fixture.request(
    missionOperations.get.path.replace(":projectId", project.id),
    { headers: { Authorization: headers.Authorization } },
  );
  assert.equal(response.status, HttpStatus.OK);
  const mission = missionSchema.parse(await response.json());
  assert.match(mission.id, /^mission_/);
  assert.equal(mission.projectId, project.id);
  assert.equal(mission.version, MISSION_INITIAL_VERSION);
  const health = await fixture.request(gatewayOperations.liveness.path);
  gatewayOperations.liveness.output.parse(await health.json());
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
