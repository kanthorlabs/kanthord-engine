import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { gatewayFixture } from "./test-support.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { custodyOperations } from "../../custody/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  MISSION_INITIAL_VERSION,
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
import { isObject } from "../../kernel/values.ts";
const MAX_OPENAPI_FRAGMENT_LINES = 200;
const ARRAY_SCHEMA_TYPE = "array";
const NULL_SCHEMA_TYPE = "null";
const CREDENTIAL_COLLECTION_FRAGMENT = "openapi/credential/create.yaml";
const CREDENTIAL_COLLECTION_MAX_LINES = 300;
const WORKER_AGENT_ENABLEMENT_ITEM_FRAGMENT =
  "openapi/worker/agent.enablement.get.yaml";
const WORKER_AGENT_ENABLEMENT_ITEM_MAX_LINES = 450;
const WORKER_AGENT_ENABLEMENT_GET_ID = "worker.agent.enablement.get";
const WORKER_AGENT_ENABLEMENT_PUT_ID = "worker.agent.enablement.put";
const WORKER_AGENT_ENABLEMENT_REMOVE_ID = "worker.agent.enablement.remove";
const PROJECT_COLLECTION_FRAGMENT = "openapi/project/create.yaml";
const PROJECT_COLLECTION_MAX_LINES = 225;
const PROJECT_BINDING_SET_FRAGMENT = "openapi/project/bindingSet.get.yaml";
const PROJECT_BINDING_SET_MAX_LINES = 625;
const MISSION_GET_PATH = "/api/mission/project/{projectId}";
const MISSION_PROJECT_NAME = "openapi-mission";
const MISSION_FRAGMENT_EXCEPTIONS = [
  {
    file: "openapi/mission/criterion.set.yaml",
    path: "/api/mission/node/{nodeId}/criterion",
    methods: { put: "mission.criterion.set" },
    maxLines: 500,
  },
  {
    file: "openapi/mission/dependency.add.yaml",
    path: "/api/mission/node/{nodeId}/dependency/{dependsOnId}",
    methods: {
      put: "mission.dependency.add",
      delete: "mission.dependency.remove",
    },
    maxLines: 975,
  },
  {
    file: "openapi/mission/import.apply.yaml",
    path: "/api/mission/{missionId}/import",
    methods: { post: "mission.import.apply" },
    maxLines: 725,
  },
  {
    file: "openapi/mission/import.preview.yaml",
    path: "/api/mission/{missionId}/import/preview",
    methods: { post: "mission.import.preview" },
    maxLines: 350,
  },
  {
    file: "openapi/mission/node.create.yaml",
    path: "/api/mission/{missionId}/node",
    methods: { post: "mission.node.create", get: "mission.node.list" },
    maxLines: 1000,
  },
  {
    file: "openapi/mission/node.get.yaml",
    path: "/api/mission/node/{nodeId}",
    methods: { get: "mission.node.get", put: "mission.node.update" },
    maxLines: 900,
  },
  {
    file: "openapi/mission/node.move.yaml",
    path: "/api/mission/node/{nodeId}/move",
    methods: { post: "mission.node.move" },
    maxLines: 500,
  },
  {
    file: "openapi/mission/node.priority.set.yaml",
    path: "/api/mission/node/{nodeId}/priority",
    methods: { post: "mission.node.priority.set" },
    maxLines: 425,
  },
  {
    file: "openapi/mission/node.rebind.yaml",
    path: "/api/mission/{missionId}/rebind",
    methods: { post: "mission.node.rebind" },
    maxLines: 825,
  },
  {
    file: "openapi/mission/node.retire.yaml",
    path: "/api/mission/node/{nodeId}/retire",
    methods: { post: "mission.node.retire" },
    maxLines: 475,
  },
  {
    file: "openapi/mission/node.revision.get.yaml",
    path: "/api/mission/node/{nodeId}/revision/{revision}",
    methods: { get: "mission.node.revision.get" },
    maxLines: 325,
  },
  {
    file: "openapi/mission/node.revision.list.yaml",
    path: "/api/mission/node/{nodeId}/revision",
    methods: { get: "mission.node.revision.list" },
    maxLines: 350,
  },
];
const apiOperations = [
  ...Object.values(gatewayOperations),
  ...Object.values(custodyOperations),
  ...Object.values(workerOperations),
  ...Object.values(schedulerOperations),
  ...Object.values(projectOperations),
  ...Object.values(missionOperations),
];
test("published OpenAPI validates, matches the registry exactly, and describes real responses", async (t) => {
  const files = emitOpenAPIFiles(apiOperations);
  const emitted = files["openapi.yaml"];
  for (const exception of MISSION_FRAGMENT_EXCEPTIONS) {
    assert.ok(Object.hasOwn(files, exception.file), exception.file);
    assert.deepEqual(emitted.paths[exception.path], {
      $ref: `./${exception.file}#/pathItem`,
    });
  }
  assert.ok(Object.hasOwn(files, WORKER_AGENT_ENABLEMENT_ITEM_FRAGMENT));
  assert.ok(Object.hasOwn(files, PROJECT_BINDING_SET_FRAGMENT));
  assert.deepEqual(emitted.paths["/api/worker/agent/enablement/{agentName}"], {
    $ref: `./${WORKER_AGENT_ENABLEMENT_ITEM_FRAGMENT}#/pathItem`,
  });
  assert.equal(
    WORKER_AGENT_ENABLEMENT_GET_ID,
    workerOperations["agent.enablement.get"].id,
  );
  assert.equal(
    WORKER_AGENT_ENABLEMENT_PUT_ID,
    workerOperations["agent.enablement.put"].id,
  );
  assert.equal(
    WORKER_AGENT_ENABLEMENT_REMOVE_ID,
    workerOperations["agent.enablement.remove"].id,
  );
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
    if (file === WORKER_AGENT_ENABLEMENT_ITEM_FRAGMENT) {
      assert.ok("pathItem" in document);
      assert.ok(isObject(document.pathItem));
      assert.deepEqual(Object.keys(document.pathItem).sort(), [
        "delete",
        "get",
        "put",
      ]);
      const methodIds = Object.fromEntries(
        Object.entries(document.pathItem).map(([method, operation]) => {
          assert.ok(isObject(operation));
          assert.ok("operationId" in operation);
          return [method, operation.operationId];
        }),
      );
      assert.deepEqual(methodIds, {
        get: WORKER_AGENT_ENABLEMENT_GET_ID,
        put: WORKER_AGENT_ENABLEMENT_PUT_ID,
        delete: WORKER_AGENT_ENABLEMENT_REMOVE_ID,
      });
      maxLines = WORKER_AGENT_ENABLEMENT_ITEM_MAX_LINES;
    }
    if (file === PROJECT_COLLECTION_FRAGMENT) {
      assert.deepEqual(emitted.paths["/api/project"], {
        $ref: `./${PROJECT_COLLECTION_FRAGMENT}#/pathItem`,
      });
      assert.ok("pathItem" in document);
      assert.ok(isObject(document.pathItem));
      assert.deepEqual(Object.keys(document.pathItem).sort(), ["get", "post"]);
      const methodIds = Object.fromEntries(
        Object.entries(document.pathItem).map(([method, operation]) => {
          assert.ok(isObject(operation));
          assert.ok("operationId" in operation);
          return [method, operation.operationId];
        }),
      );
      assert.deepEqual(methodIds, {
        get: projectOperations.list.id,
        post: projectOperations.create.id,
      });
      maxLines = PROJECT_COLLECTION_MAX_LINES;
    }
    if (file === PROJECT_BINDING_SET_FRAGMENT) {
      assert.deepEqual(emitted.paths["/api/project/{projectId}/binding-set"], {
        $ref: `./${PROJECT_BINDING_SET_FRAGMENT}#/pathItem`,
      });
      assert.ok("pathItem" in document);
      assert.ok(isObject(document.pathItem));
      assert.deepEqual(Object.keys(document.pathItem).sort(), ["get", "put"]);
      const methodIds = Object.fromEntries(
        Object.entries(document.pathItem).map(([method, operation]) => {
          assert.ok(isObject(operation));
          assert.ok("operationId" in operation);
          return [method, operation.operationId];
        }),
      );
      assert.deepEqual(methodIds, {
        get: projectOperations["bindingSet.get"].id,
        put: projectOperations["bindingSet.write"].id,
      });
      maxLines = PROJECT_BINDING_SET_MAX_LINES;
    }
    const missionException = MISSION_FRAGMENT_EXCEPTIONS.find(
      (exception) => exception.file === file,
    );
    if (missionException) {
      assert.ok("pathItem" in document);
      assert.ok(isObject(document.pathItem));
      const methodIds = Object.fromEntries(
        Object.entries(document.pathItem).map(([method, operation]) => {
          assert.ok(isObject(operation));
          assert.ok("operationId" in operation);
          return [method, operation.operationId];
        }),
      );
      assert.deepEqual(methodIds, missionException.methods);
      maxLines = missionException.maxLines;
    }
    assert.ok(
      content.split("\n").length <= maxLines,
      `${file} must stay small enough to review as one scope`,
    );
  }
  const resolved = await SwaggerParser.validate(openapiPath());
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
