import assert from "node:assert/strict";
import { test } from "node:test";
import { ulid } from "ulid";
import { parse } from "yaml";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import SwaggerParser from "@apidevtools/swagger-parser";
import { gatewayFixture } from "./test-support.ts";
import { gatewayOperations, HEALTHCHECK_OK } from "../../gateway/contract.ts";
import { llmOperations } from "../../llm/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import { storageOperations } from "../../storage/contract.ts";
import { ActionResultKind, workerOperations } from "../../worker/contract.ts";
import {
  agentOperations,
  agentProviderKindSchema,
} from "../../agent/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  MISSION_INITIAL_VERSION,
  NodeKind,
  AssetKind,
  missionOperations,
  missionSchema,
} from "../../mission/contract.ts";
import { workbenchOperations } from "../../workbench/contract.ts";
import {
  intakeOperations,
  webhookInboundSchema,
} from "../../intake/contract.ts";
import {
  openapiPath,
  emitOpenAPI,
  emitOpenAPIFiles,
  serializeOpenAPIFile,
} from "../../gateway/local.ts";
import { errorSchema } from "../../kernel/errors.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  AccessPolicy,
  hasHttpRoute,
  OperationRegistry,
  OperationResultType,
} from "../../kernel/operation.ts";
import { testMachineIdentity } from "../../kernel/test-identity.ts";
import { directClient } from "../../gateway/index.ts";
import { ResourceStatus } from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { isObject, isString } from "../../kernel/values.ts";
const OPENAPI_FRAGMENT_SOFT_LIMIT_LINES = 500;
const INBOUND_CREATED = 201;
const INBOUND_ONE_ROW = 1;
const INBOUND_NO_LOGS = 0;
const INBOUND_VALIDATION_FAILED = "gateway.request.validation_failed";
const INBOUND_UNAUTHORIZED = "gateway.authentication.unauthorized";
const INBOUND_NOT_FOUND = "intake.inbound.not_found";
const INBOUND_EMPTY_BODY = "";

test("published native setup is an execution-scoped bodyless read", () => {
  const operation = workerOperations["execution.setup.get"];
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/worker/execution.setup.get.yaml"),
      "utf8",
    ),
  );
  assert.equal(fragment.pathItem.get.operationId, operation.id);
  assert.equal(fragment.pathItem.get.requestBody, undefined);
  assert.equal(operation.requiresExecution, true);
  const index = parse(readFileSync(openapiPath(), "utf8"));
  assert.ok(index.paths["/api/worker/execution/{execution_id}/setup"]);
});

test("published action performer preserves its route and discriminated result classes", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/worker/action.request.yaml"),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.post.operationId,
    workerOperations["action.request"].id,
  );
  const output = fragment.components.schemas["worker.action.request.Output"];
  assert.deepEqual(
    output.properties.items.items.oneOf.map(
      (variant: { properties: { kind: { const: string } } }) =>
        variant.properties.kind.const,
    ),
    Object.values(ActionResultKind),
  );
  assert.equal(fragment.pathItem.post.requestBody, undefined);
});

test("published handover operations preserve execution proof and bodyless report success", () => {
  const reportName = "credential";
  for (const name of ["handover", "credential"] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/worker/${name}.yaml`),
        "utf8",
      ),
    );
    const operation = fragment.pathItem.post;
    assert.equal(operation.operationId, workerOperations[name].id);
    assert(workerOperations[name].requiresExecution);
    assert(
      fragment.components.schemas[`worker.${name}.Input`].properties.body
        .properties.execution_id,
    );
    if (name === reportName)
      assert.equal(
        operation.responses[HttpStatus.NoContent].content,
        undefined,
      );
  }
});

test("published execution objective reads name their operations", () => {
  for (const name of [
    "execution.objective.list",
    "execution.objective.outcome.list",
    "execution.objective.evidence.list",
  ] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${name}.yaml`),
        "utf8",
      ),
    );
    assert.equal(fragment.pathItem.get.operationId, missionOperations[name].id);
    assert.ok(missionOperations[name].requiresExecution);
  }
});

test("published execution evidence and cleared outcome name their operations", () => {
  for (const name of [
    "execution.evidence.list",
    "execution.clearedOutcome.get",
  ] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${name}.yaml`),
        "utf8",
      ),
    );
    assert.equal(fragment.pathItem.get.operationId, missionOperations[name].id);
    assert.ok(missionOperations[name].requiresExecution);
  }
});

test("published execution revisions name each bounded operation", () => {
  for (const name of [
    "execution.pinnedRevision.get",
    "execution.revision.get",
    "execution.revision.list",
  ] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${name}.yaml`),
        "utf8",
      ),
    );
    assert.equal(fragment.pathItem.get.operationId, missionOperations[name].id);
    assert.ok(missionOperations[name].requiresExecution);
  }
});

test("published evidence delete preserves its bodyless 204 response", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/mission/evidence.delete.yaml"),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.delete.operationId,
    missionOperations["evidence.delete"].id,
  );
  assert.equal(
    fragment.pathItem.delete.responses[HttpStatus.NoContent].content,
    undefined,
  );
});

test("published asset delete names its operation with a bodyless 204 response", () => {
  const fragment = parse(
    readFileSync(
      join(
        dirname(openapiPath()),
        "openapi/mission/evidence.asset.delete.yaml",
      ),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.delete.operationId,
    missionOperations["evidence.asset.delete"].id,
  );
  assert.equal(
    fragment.pathItem.delete.responses[HttpStatus.NoContent].content,
    undefined,
  );
});

test("published node check names its operation", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/mission/node.check.yaml"),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.post.operationId,
    missionOperations["node.check"].id,
  );
  assert.equal(missionOperations["node.check"].access, AccessPolicy.Human);
});

test("published content reads name their bounded operations", () => {
  for (const name of [
    "evidence.asset.content.get",
    "execution.evidence.asset.content.get",
  ] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${name}.yaml`),
        "utf8",
      ),
    );
    assert.equal(fragment.pathItem.get.operationId, missionOperations[name].id);
    assert.ok(fragment.pathItem.get.responses);
  }
});

test("published evidence reads name their operations", () => {
  for (const [name, file] of [
    ["evidence.list", "evidence.list"],
    ["evidence.get", "evidence.delete"],
  ] as const) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${file}.yaml`),
        "utf8",
      ),
    );
    assert.equal(fragment.pathItem.get.operationId, missionOperations[name].id);
    assert.equal(missionOperations[name].access, AccessPolicy.Human);
  }
});

test("published evidence submit names its execution operation", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/mission/evidence.list.yaml"),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.post.operationId,
    missionOperations["evidence.submit"].id,
  );
  assert.ok(missionOperations["evidence.submit"].requiresExecution);
});

test("published evidence request names its execution operation", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/mission/evidence.request.yaml"),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.post.operationId,
    missionOperations["evidence.request"].id,
  );
  assert.ok(missionOperations["evidence.request"].requiresExecution);
});

test("published evidence completion names its execution operation", () => {
  const fragment = parse(
    readFileSync(
      join(
        dirname(openapiPath()),
        "openapi/mission/evidence.asset.complete.yaml",
      ),
      "utf8",
    ),
  );
  assert.equal(
    fragment.pathItem.post.operationId,
    missionOperations["evidence.asset.complete"].id,
  );
  assert.ok(missionOperations["evidence.asset.complete"].requiresExecution);
});

test("published heartbeat projection names its operation and carries no 204 content", () => {
  const fragment = readFileSync(
    join(dirname(openapiPath()), "openapi/worker/heartbeat.yaml"),
    "utf8",
  );
  const document = parse(fragment) as {
    pathItem: {
      post: {
        operationId: string;
        responses: Record<string, { content?: unknown }>;
      };
    };
  };
  assert.equal(
    document.pathItem.post.operationId,
    workerOperations.heartbeat.id,
  );
  const response = document.pathItem.post.responses[HttpStatus.NoContent];
  assert.ok(response);
  assert.equal("content" in response, false);
});
const MISSION_BLOCKED_CONTEXT_FRAGMENT_EXCEPTIONS = [
  ["assessment.list", "mission.assessment.submit", "properties", "node"],
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
const EVIDENCE_FRAGMENT_EXCEPTIONS = [
  ["evidence.delete", "mission.evidence.get", false],
  ["evidence.list", "mission.evidence.list", true],
  ["evidence.request", "mission.evidence.request", false],
  ["execution.evidence.list", "mission.execution.evidence.list", true],
  [
    "execution.objective.evidence.list",
    "mission.execution.objective.evidence.list",
    true,
  ],
] as const;
const LEGACY_FRAGMENT_EXCEPTIONS = [
  "openapi/mission/dependency.add.yaml",
  "openapi/mission/import.apply.yaml",
  "openapi/project/bindingSet.get.yaml",
];
const AGENT_PROVIDER_FRAGMENT_EXCEPTION = "openapi/agent/enablement.get.yaml";
const PROVIDER_PROPERTY = "provider";
const ENUM_KEYWORD = "enum";
const AGENT_PROVIDER_ENUM_COUNT = 3;
const NAMED_FRAGMENT_EXCEPTIONS = new Set([
  ...MISSION_BLOCKED_CONTEXT_FRAGMENT_EXCEPTIONS.map(
    ([file]) => `openapi/mission/${file}.yaml`,
  ),
  ...EVIDENCE_FRAGMENT_EXCEPTIONS.map(
    ([file]) => `openapi/mission/${file}.yaml`,
  ),
  "openapi/mission/execution.objective.list.yaml",
  ...LEGACY_FRAGMENT_EXCEPTIONS,
  AGENT_PROVIDER_FRAGMENT_EXCEPTION,
]);
const NULL_SCHEMA_TYPE = "null";
const STRING_SCHEMA_TYPE = "string";
const NONEMPTY_STRING_MIN_LENGTH = 1;
const OPERATION_PREFIXES = [
  "gateway.",
  "llm.",
  "repository.",
  "storage.",
  "agent.",
  "scheduler.",
  "worker.",
  "project.",
  "mission.",
  "workbench.",
  "intake.",
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
  oneOf?: ResolvedSchema[];
  allOf?: ResolvedSchema[];
  items?: ResolvedSchema;
  const?: unknown;
  type?: string;
  minLength?: number;
  not?: unknown;
};

function assertInstanceOutput(schema: ResolvedSchema): void {
  assert.ok(schema.allOf);
  const [base, host, registration, activity] = schema.allOf;
  assert.equal(base?.additionalProperties, false);
  assert.deepEqual(base?.required, [
    "runtime_identity",
    "project_id",
    "resource_identity",
    "worker_name",
    "host",
    "activity",
    "draining",
    "registered",
  ]);
  for (const union of [host, registration, activity])
    for (const variant of union!.anyOf!)
      assert.notEqual(variant.additionalProperties, false);
  assert.deepEqual(
    host?.anyOf?.map((variant) => variant.required),
    [["host", "placement"], ["host"]],
  );
  assert.deepEqual(
    registration?.anyOf?.map((variant) => variant.required),
    [["registered", "client_id", "name"], ["registered"]],
  );
  assert.deepEqual(
    activity?.anyOf?.map((variant) => variant.required),
    [["activity", "execution_id"], ["activity"]],
  );
  const second = 1;
  assert.deepEqual(host?.anyOf?.[second]?.properties.placement?.not, {});
  assert.deepEqual(
    registration?.anyOf?.[second]?.properties.client_id?.not,
    {},
  );
  assert.deepEqual(registration?.anyOf?.[second]?.properties.name?.not, {});
  assert.deepEqual(activity?.anyOf?.[second]?.properties.execution_id?.not, {});
}

test("published Worker lists preserve optional limits, filter dependency and conditional records", async () => {
  const api = await SwaggerParser.dereference(openapiPath());
  const integer = "integer";
  const limitName = "limit";
  const defaultLimit = 100;
  const minimum = 1;
  const maximum = 1000;
  for (const path of ["/api/worker/catalog", "/api/worker/instance"]) {
    const operation = api.paths?.[path]?.get as unknown as {
      parameters: {
        name: string;
        required: boolean;
        schema: {
          type: string;
          minimum: number;
          maximum: number;
          default: number;
        };
      }[];
      responses: Record<string, ResolvedJsonResponse>;
      "x-access-policy": string;
    };
    assert.ok(operation);
    assert.equal(operation["x-access-policy"], AccessPolicy.Human);
    const limit = operation.parameters.find(
      (parameter) => parameter.name === limitName,
    );
    assert.ok(limit);
    assert.equal(limit.required, false);
    assert.equal(limit.schema.type, integer);
    assert.equal(limit.schema.default, defaultLimit);
    assert.equal(limit.schema.minimum, minimum);
    assert.equal(limit.schema.maximum, maximum);
    const output =
      operation.responses[HttpStatus.OK]!.content["application/json"].schema;
    assert.deepEqual(output.required, ["items", "next_cursor"]);
    assert.equal(output.properties.items?.type, ARRAY_SCHEMA_TYPE);
  }
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/worker/instance.list.yaml"),
      "utf8",
    ),
  ) as {
    components: {
      schemas: Record<
        string,
        {
          properties: Record<
            string,
            {
              dependentRequired?: unknown;
              properties: Record<string, { description?: string }>;
            }
          >;
        }
      >;
    };
  };
  const query =
    fragment.components.schemas["worker.instance.list.Input"]!.properties
      .query!;
  assert.deepEqual(query.dependentRequired, {
    resource_identity: ["project_id"],
  });
  assert.match(
    query.properties.resource_identity!.description!,
    /Requires project_id/,
  );
  const list = api.paths?.["/api/worker/instance"]?.get?.responses[
    HttpStatus.OK
  ] as unknown as ResolvedJsonResponse;
  const get = api.paths?.["/api/worker/instance/{runtime_identity}"]?.get
    ?.responses[HttpStatus.OK] as unknown as ResolvedJsonResponse;
  assertInstanceOutput(
    list.content["application/json"].schema.properties.items!.items!,
  );
  assertInstanceOutput(get.content["application/json"].schema);
});
type ResolvedJsonResponse = {
  content: { "application/json": { schema: ResolvedSchema } };
};
type ResolvedOperation = {
  operationId?: string;
  "x-access-policy"?: string;
  "x-timeout-ms"?: number;
  security?: unknown;
};
const MISSION_GET_PATH = "/api/mission/project/{project_id}";
const MISSION_PROJECT_NAME = "openapi-mission";
const apiOperations = [
  ...Object.values(gatewayOperations),
  ...Object.values(llmOperations),
  ...Object.values(repositoryOperations),
  ...Object.values(storageOperations),
  ...Object.values(agentOperations),
  ...Object.values(workerOperations),
  ...Object.values(schedulerOperations),
  ...Object.values(projectOperations),
  ...Object.values(missionOperations),
  ...Object.values(workbenchOperations),
  ...Object.values(intakeOperations),
];
const OPERATION_INVENTORY: readonly (readonly [string, AccessPolicy])[] = [
  ["gateway.liveness", AccessPolicy.Public],
  ["gateway.openapi", AccessPolicy.Public],
  ["gateway.openapiFile", AccessPolicy.Public],
  ["gateway.healthcheck", AccessPolicy.Human],
  ["gateway.verify", AccessPolicy.Human],
  ["llm.credential.create", AccessPolicy.Human],
  ["llm.credential.list", AccessPolicy.Human],
  ["llm.credential.get", AccessPolicy.Human],
  ["llm.credential.rotate", AccessPolicy.Human],
  ["llm.credential.update_metadata", AccessPolicy.Human],
  ["llm.credential.revoke", AccessPolicy.Human],
  ["llm.credential.archive", AccessPolicy.Human],
  ["llm.credential.login", AccessPolicy.Human],
  ["llm.credential.login_code", AccessPolicy.Human],
  ["llm.credential.login_status", AccessPolicy.Human],
  ["llm.credential.platform_list", AccessPolicy.Human],
  ["llm.credential.check", AccessPolicy.Human],
  ["llm.credential.verify", AccessPolicy.Human],
  ["llm.provider.check", AccessPolicy.Human],
  ["repository.credential.create", AccessPolicy.Human],
  ["repository.credential.list", AccessPolicy.Human],
  ["repository.credential.get", AccessPolicy.Human],
  ["repository.credential.rotate", AccessPolicy.Human],
  ["repository.credential.ssh_discover", AccessPolicy.Human],
  ["repository.credential.update_metadata", AccessPolicy.Human],
  ["repository.credential.revoke", AccessPolicy.Human],
  ["repository.credential.archive", AccessPolicy.Human],
  ["repository.credential.platform_list", AccessPolicy.Human],
  ["repository.credential.check", AccessPolicy.Human],
  ["repository.credential.verify", AccessPolicy.Human],
  ["storage.credential.create", AccessPolicy.Human],
  ["storage.credential.list", AccessPolicy.Human],
  ["storage.credential.get", AccessPolicy.Human],
  ["storage.credential.rotate", AccessPolicy.Human],
  ["storage.credential.update_metadata", AccessPolicy.Human],
  ["storage.credential.revoke", AccessPolicy.Human],
  ["storage.credential.archive", AccessPolicy.Human],
  ["storage.credential.platform_list", AccessPolicy.Human],
  ["storage.credential.check", AccessPolicy.Human],
  ["storage.credential.verify", AccessPolicy.Human],
  ["agent.enablement.list", AccessPolicy.Human],
  ["agent.enablement.get", AccessPolicy.Human],
  ["agent.enablement.put", AccessPolicy.Human],
  ["agent.enablement.enable", AccessPolicy.Human],
  ["agent.enablement.disable", AccessPolicy.Human],
  ["agent.enablement.remove", AccessPolicy.Human],
  ["agent.enablement.provider.add", AccessPolicy.Human],
  ["agent.enablement.provider.remove", AccessPolicy.Human],
  ["agent.enablement.provider.model.list", AccessPolicy.Human],
  ["agent.model.list", AccessPolicy.Human],
  ["agent.prompt.put", AccessPolicy.Human],
  ["agent.prompt.switch", AccessPolicy.Human],
  ["agent.prompt.get", AccessPolicy.Human],
  ["worker.catalog.list", AccessPolicy.Human],
  ["worker.catalog.get", AccessPolicy.Human],
  ["agent.get", AccessPolicy.Human],
  ["worker.instance.list", AccessPolicy.Human],
  ["worker.instance.get", AccessPolicy.Human],
  ["worker.instance.resume", AccessPolicy.Human],
  ["worker.register", AccessPolicy.Client],
  ["worker.heartbeat", AccessPolicy.Client],
  ["worker.handover", AccessPolicy.Client],
  ["worker.credential", AccessPolicy.Client],
  ["worker.instance.deregister", AccessPolicy.Client],
  ["worker.action.request", AccessPolicy.Client],
  ["worker.execution.setup.get", AccessPolicy.Client],
  ["scheduler.queue.list", AccessPolicy.Human],
  ["scheduler.queue.peek", AccessPolicy.Human],
  ["scheduler.execution.list", AccessPolicy.Human],
  ["scheduler.execution.get", AccessPolicy.Human],
  ["scheduler.work.pull", AccessPolicy.Client],
  ["scheduler.claim.get", AccessPolicy.Client],
  ["scheduler.execution.release", AccessPolicy.Client],
  ["project.create", AccessPolicy.Human],
  ["project.list", AccessPolicy.Human],
  ["project.get", AccessPolicy.Human],
  ["project.rename", AccessPolicy.Human],
  ["project.binding.list", AccessPolicy.Human],
  ["project.binding.get", AccessPolicy.Human],
  ["project.binding.verify", AccessPolicy.Human],
  ["project.binding.check", AccessPolicy.Human],
  ["project.bindingSet.get", AccessPolicy.Human],
  ["project.bindingSet.write", AccessPolicy.Human],
  ["project.bindingRevision.list", AccessPolicy.Human],
  ["project.agentConfiguration.list", AccessPolicy.Human],
  ["project.agentConfiguration.get", AccessPolicy.Human],
  ["mission.get", AccessPolicy.Human],
  ["mission.export", AccessPolicy.Human],
  ["mission.import.preview", AccessPolicy.Human],
  ["mission.import.apply", AccessPolicy.Human],
  ["mission.edge.list", AccessPolicy.Human],
  ["mission.dependency.add", AccessPolicy.Human],
  ["mission.dependency.remove", AccessPolicy.Human],
  ["mission.node.list", AccessPolicy.Human],
  ["mission.node.get", AccessPolicy.Human],
  ["mission.node.create", AccessPolicy.Human],
  ["mission.node.update", AccessPolicy.Human],
  ["mission.node.move", AccessPolicy.Human],
  ["mission.node.revision.list", AccessPolicy.Human],
  ["mission.node.revision.get", AccessPolicy.Human],
  ["mission.node.retire.preview", AccessPolicy.Human],
  ["mission.node.retire", AccessPolicy.Human],
  ["mission.node.rebind", AccessPolicy.Human],
  ["mission.node.priority.set", AccessPolicy.Human],
  ["mission.criterion.set", AccessPolicy.Human],
  ["mission.node.pause", AccessPolicy.Human],
  ["mission.node.resume", AccessPolicy.Human],
  ["mission.node.block", AccessPolicy.Human],
  ["mission.node.unblock", AccessPolicy.Human],
  ["mission.node.ready", AccessPolicy.Human],
  ["mission.node.override", AccessPolicy.Human],
  ["mission.node.discard", AccessPolicy.Human],
  ["mission.node.check", AccessPolicy.Human],
  ["mission.delivery.admit", AccessPolicy.Service],
  ["mission.attempt.list", AccessPolicy.Human],
  ["mission.attempt.get", AccessPolicy.Human],
  ["mission.evidence.list", AccessPolicy.Human],
  ["mission.evidence.get", AccessPolicy.Human],
  ["mission.evidence.asset.content.get", AccessPolicy.Human],
  ["mission.evidence.asset.delete", AccessPolicy.Human],
  ["mission.evidence.delete", AccessPolicy.Human],
  ["mission.assessment.list", AccessPolicy.Human],
  ["mission.assessment.get", AccessPolicy.Human],
  ["mission.outcome.list", AccessPolicy.Human],
  ["mission.outcome.get", AccessPolicy.Human],
  ["mission.externalAction.list", AccessPolicy.Human],
  ["mission.externalAction.get", AccessPolicy.Human],
  ["mission.evidence.submit", AccessPolicy.Client],
  ["mission.evidence.asset.complete", AccessPolicy.Client],
  ["mission.evidence.request", AccessPolicy.Client],
  ["mission.assessment.submit", AccessPolicy.Client],
  ["mission.execution.pinnedRevision.get", AccessPolicy.Client],
  ["mission.execution.revision.list", AccessPolicy.Client],
  ["mission.execution.revision.get", AccessPolicy.Client],
  ["mission.execution.evidence.list", AccessPolicy.Client],
  ["mission.execution.evidence.asset.content.get", AccessPolicy.Client],
  ["mission.execution.objective.list", AccessPolicy.Client],
  ["mission.execution.objective.outcome.list", AccessPolicy.Client],
  ["mission.execution.objective.evidence.list", AccessPolicy.Client],
  ["mission.execution.clearedOutcome.get", AccessPolicy.Client],
  ["workbench.session.list", AccessPolicy.Human],
  ["workbench.session.create", AccessPolicy.Human],
  ["workbench.session.get", AccessPolicy.Human],
  ["workbench.session.configure", AccessPolicy.Human],
  ["workbench.session.message", AccessPolicy.Human],
  ["workbench.session.abort", AccessPolicy.Human],
  ["workbench.session.events", AccessPolicy.Human],
  ["workbench.session.approve", AccessPolicy.Human],
  ["intake.outbound.request.list", AccessPolicy.Human],
  ["intake.outbound.request.get", AccessPolicy.Human],
  ["intake.outbound.request.discard", AccessPolicy.Human],
  ["intake.outbound.request.delete", AccessPolicy.Human],
  ["intake.inbound.create", AccessPolicy.Human],
  ["intake.inbound.list", AccessPolicy.Human],
  ["intake.inbound.get", AccessPolicy.Human],
  ["intake.inbound.delete", AccessPolicy.Human],
  ["intake.inbound.event.list", AccessPolicy.Human],
  ["intake.inbound.event.get", AccessPolicy.Human],
  ["intake.inbound.event.retry", AccessPolicy.Human],
  ["intake.inbound.event.discard", AccessPolicy.Human],
  ["intake.inbound.event.receive", AccessPolicy.Delivery],
  ["intake.action.check", AccessPolicy.Service],
  ["intake.action.perform", AccessPolicy.Client],
  ["intake.action.read", AccessPolicy.Client],
  ["intake.storage.put", AccessPolicy.Client],
  ["intake.storage.check", AccessPolicy.Client],
  ["intake.execution.storage.get", AccessPolicy.Client],
  ["intake.storage.get", AccessPolicy.Human],
  ["intake.storage.delete", AccessPolicy.Human],
];
const OPERATION_COUNT = 169;
const routedOperationIds = new Set<string>(
  apiOperations.filter(hasHttpRoute).map(({ id }) => id),
);

test("the operation inventory agrees with contracts, OpenAPI and live registry", async (t) => {
  const expected = [...OPERATION_INVENTORY].sort();
  assert.equal(expected.length, OPERATION_COUNT);
  assert.deepEqual(
    apiOperations.map(({ id, access }) => [id, access]).sort(),
    expected,
  );
  const resolved = await SwaggerParser.dereference(openapiPath());
  const published = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {})
      .filter(
        (item): item is ResolvedOperation =>
          isObject(item) && "operationId" in item && isString(item.operationId),
      )
      .map((item) => [item.operationId, item["x-access-policy"]]),
  );
  assert.deepEqual(
    published.sort(),
    expected.filter(([id]) => routedOperationIds.has(id)),
  );
  const registry = new OperationRegistry();
  await gatewayFixture(t, { registry });
  assert.deepEqual(
    registry
      .all()
      .map(({ operation }) => [operation.id, operation.access])
      .sort(),
    expected,
  );
});

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
    const context = variant.properties.blocked_context;
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
        "assessment_id",
        "attempt",
        "closing_event",
        "created_at",
        "evidence_ids",
        "id",
        "node_id",
        "node_revision",
        "result",
      ],
    );
  }
}

function assertEvidenceShape(schema: ResolvedSchema): void {
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "assets",
    "attempt",
    "created_at",
    "end_state",
    "id",
    "node_id",
    "provenance",
    "requirement_key",
    "subject",
    "verification",
  ]);
  assert.deepEqual(schema.required, [
    "id",
    "node_id",
    "attempt",
    "subject",
    "assets",
    "provenance",
    "created_at",
  ]);
  const variants = schema.properties.assets!.items!.oneOf!;
  assert.deepEqual(
    variants.map((item) => item.properties.kind!.const),
    ["repository", "produced", "object", "platform"],
  );
  for (const asset of variants) {
    assert.deepEqual(asset.required, [
      "id",
      "published_at",
      "expired_at",
      "kind",
      "address",
      ...(asset.properties.kind!.const === AssetKind.Object
        ? ["storage_binding_id", "size", "media_type"]
        : []),
    ]);
    for (const field of ["published_at", "expired_at"])
      assert.ok(
        asset.properties[field]!.anyOf!.some(
          (item) => item.type === NULL_SCHEMA_TYPE,
        ),
      );
    assert.ok(asset.properties.address);
  }
  assert.deepEqual(schema.properties.verification!.required, [
    "tested_input",
    "results",
  ]);
  assert.deepEqual(
    schema.properties.provenance!.oneOf!.map(
      (item) => item.properties.kind!.const,
    ),
    ["human", "execution", "service"],
  );
}

test("named evidence exceptions retain record shapes and conditional request validation", () => {
  for (const [file, operation, page] of EVIDENCE_FRAGMENT_EXCEPTIONS) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${file}.yaml`),
        "utf8",
      ),
    );
    const output = fragment.components.schemas[
      `${operation}.Output`
    ] as ResolvedSchema;
    if (page) {
      assert.deepEqual(output.required, ["items", "next_cursor"]);
      assert.ok(
        output.properties.next_cursor!.anyOf!.some(
          (item) => item.type === NULL_SCHEMA_TYPE,
        ),
      );
    }
    assertEvidenceShape(page ? output.properties.items!.items! : output);
  }
  for (const name of ["evidence.delete", "evidence.asset.delete"]) {
    const fragment = parse(
      readFileSync(
        join(dirname(openapiPath()), `openapi/mission/${name}.yaml`),
        "utf8",
      ),
    );
    const input =
      fragment.components.schemas[`mission.${name}.Input`].properties.body;
    assert.deepEqual(input.if, {
      properties: { force: { const: true } },
      required: ["force"],
    });
    assert.deepEqual(input.then, { required: ["reason"] });
  }
  const assessment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/mission/assessment.list.yaml"),
      "utf8",
    ),
  );
  for (const field of ["evidence_ids", "child_outcome_ids"])
    assert.equal(
      assessment.components.schemas["mission.assessment.submit.Input"]
        .properties.body.properties[field].uniqueItems,
      true,
    );
});

test("objective list exception preserves full objective and identity-only variants", () => {
  const fragment = parse(
    readFileSync(
      join(
        dirname(openapiPath()),
        "openapi/mission/execution.objective.list.yaml",
      ),
      "utf8",
    ),
  );
  const output =
    fragment.components.schemas["mission.execution.objective.list.Output"];
  assert.deepEqual(output.required, ["items", "next_cursor"]);
  const [full, minimal] = output.properties.items.items.anyOf;
  assert.deepEqual(minimal.required, ["id", "state"]);
  assert.deepEqual(Object.keys(minimal.properties).sort(), ["id", "state"]);
  assert.equal(minimal.additionalProperties, false);
  assert.deepEqual(full.required, [
    "id",
    "filename",
    "mission_id",
    "parent_id",
    "visible_revision",
    "content",
    "retired_at",
    "pinned_by_attempts",
    "kind",
    "state",
    "attempt",
    "priority",
    "depends_on",
  ]);
  assert.deepEqual(full.properties.blocked_context.required, [
    "outcome",
    "requests",
  ]);
});

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
test("the agent enablement fragment exceeds the soft limit only through the agent provider enum", () => {
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), AGENT_PROVIDER_FRAGMENT_EXCEPTION),
      "utf8",
    ),
  );
  const enums: unknown[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(collect);
    if (!isObject(value)) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === PROVIDER_PROPERTY && isObject(entry) && ENUM_KEYWORD in entry)
        enums.push(entry.enum);
      collect(entry);
    }
  };
  collect(fragment.components.schemas);
  assert.equal(enums.length, AGENT_PROVIDER_ENUM_COUNT);
  for (const values of enums)
    assert.deepEqual(values, agentProviderKindSchema.options);
});
test("published OpenAPI validates, matches the registry exactly, and describes real responses", async (t) => {
  const files = emitOpenAPIFiles(apiOperations);
  const emitted = files["openapi.yaml"];
  const credentialPaths = new Set(
    [llmOperations, repositoryOperations, storageOperations]
      .flatMap((operations) => Object.values(operations))
      .map(({ path }) => path.replace(/:([^/]+)/g, "{$1}")),
  );
  for (const path of credentialPaths) assert.ok(path in emitted.paths, path);
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
      assert.ok(
        NAMED_FRAGMENT_EXCEPTIONS.has(file),
        `${file} requires a named shape-checked exception`,
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
    [...routedOperationIds].sort(),
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
    resolved.paths?.["/api/worker/instance"]?.get?.operationId,
    workerOperations["instance.list"].id,
  );
  assert.equal(
    resolved.paths?.["/api/worker/instance/{runtime_identity}"]?.get
      ?.operationId,
    workerOperations["instance.get"].id,
  );
  assert.equal(
    resolved.paths?.["/api/worker/instance/{runtime_identity}/resume"]?.post
      ?.operationId,
    workerOperations["instance.resume"].id,
  );
  assert.equal(
    resolved.paths?.["/api/worker/instance/{runtime_identity}"]?.delete
      ?.operationId,
    workerOperations["instance.deregister"].id,
  );
  for (const operation of [
    workerOperations["catalog.list"],
    workerOperations["catalog.get"],
    agentOperations.get,
  ]) {
    const published = resolved.paths?.[
      operation.path
        .replace(":worker_name", "{worker_name}")
        .replace(":agent_name", "{agent_name}")
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
  assert.deepEqual(Object.keys(shared.properties), [
    "llm",
    "repository",
    "storage",
    "agent",
  ]);
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
    resolved.paths?.["/api/project/{project_id}/binding-set"]?.put?.operationId,
    projectOperations["bindingSet.write"].id,
  );
  const emittedAgentIds = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path).map(
      (operation) => (operation as { operationId?: string }).operationId,
    ),
  );
  for (const id of [
    "agent.enablement.list",
    "agent.enablement.get",
    "agent.enablement.put",
    "agent.enablement.enable",
    "agent.enablement.disable",
    "agent.enablement.remove",
    "agent.enablement.provider.add",
    "agent.enablement.provider.remove",
    "agent.enablement.provider.model.list",
    "agent.model.list",
    "agent.prompt.put",
    "agent.prompt.switch",
    "agent.prompt.get",
  ])
    assert.ok(emittedAgentIds.includes(id), id);
  for (const operation of [
    llmOperations,
    repositoryOperations,
    storageOperations,
  ].flatMap((operations) => Object.values(operations))) {
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    const method = operation.method.toLowerCase() as "get" | "post" | "put";
    assert.equal(resolved.paths?.[path]?.[method]?.operationId, operation.id);
  }
  for (const operation of Object.values(schedulerOperations)) {
    const path = operation.path.replace(/:([^/]+)/g, "{$1}");
    const method = operation.method.toLowerCase() as "get" | "post";
    assert.equal(resolved.paths?.[path]?.[method]?.operationId, operation.id);
  }
  const pullResponse = resolved.paths?.[schedulerOperations.workPull.path]?.post
    ?.responses[HttpStatus.OK] as unknown as {
    content: { "application/json": { schema: { oneOf: ResolvedSchema[] } } };
  };
  const executionListPath = schedulerOperations.executionList.path.replace(
    /:([^/]+)/g,
    "{$1}",
  );
  const executionFragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/scheduler/execution.list.yaml"),
      "utf8",
    ),
  ) as {
    components: {
      schemas: Record<
        string,
        {
          properties: {
            query: {
              dependentRequired?: unknown;
              properties: { attempt: { description?: string } };
            };
          };
        }
      >;
    };
  };
  const executionQuery =
    executionFragment.components.schemas["scheduler.execution.list.Input"]!
      .properties.query;
  assert.deepEqual(executionQuery.dependentRequired, { attempt: ["node_id"] });
  assert.match(
    executionQuery.properties.attempt.description!,
    /Requires node_id/,
  );
  const executionPage = resolved.paths?.[executionListPath]?.get?.responses[
    HttpStatus.OK
  ] as unknown as {
    content: { "application/json": { schema: ResolvedSchema } };
  };
  assert.deepEqual(
    Object.keys(
      executionPage.content["application/json"].schema.properties,
    ).sort(),
    ["items", "next_cursor"],
  );
  assert.deepEqual(
    pullResponse.content["application/json"].schema.oneOf.map(
      (variant) => variant.properties.kind?.const,
    ),
    ["claimed", "no-work"],
  );
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
            next_cursor: { anyOf: { type: string }[] };
          };
        };
      };
    };
  };
  const queueListProperties =
    queueListResponse.content["application/json"].schema.properties;
  assert.equal(queueListProperties.items.type, ARRAY_SCHEMA_TYPE);
  assert.ok(
    queueListProperties.next_cursor.anyOf.some(
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
    { id: "string", project_id: "string", version: "integer" },
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
      ["items", "next_cursor"],
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
    missionOperations.get.path.replace(":project_id", project.id),
    { headers: { Authorization: headers.Authorization } },
  );
  assert.equal(response.status, HttpStatus.OK);
  const mission = missionSchema.parse(await response.json());
  assert.match(mission.id, /^mission_/);
  assert.equal(mission.project_id, project.id);
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
        schema: { properties: { runtime_identity: { type: string } } };
      };
    };
  };
  assert.equal(
    authResponse.content["application/json"].schema.properties.runtime_identity
      .type,
    STRING_SCHEMA_TYPE,
  );
  assert.deepEqual(
    Object.keys(
      authResponse.content["application/json"].schema.properties,
    ).sort(),
    ["resource_identity", "runtime_identity", "worker_name"],
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

test("the direct intake operations have no OpenAPI path", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const directIds = new Set<string>([
    intakeOperations["action.perform"].id,
    intakeOperations["action.read"].id,
    intakeOperations["storage.put"].id,
    intakeOperations["storage.check"].id,
    intakeOperations["execution.storage.get"].id,
    intakeOperations["storage.get"].id,
    intakeOperations["storage.delete"].id,
  ]);
  const published = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {}).filter(
      (item) => isObject(item) && "operationId" in item,
    ),
  );
  assert.ok(published.length);
  assert.ok(
    published.every(
      (item) => !directIds.has((item as ResolvedOperation).operationId ?? ""),
    ),
  );
  assert.equal(
    Object.keys(resolved.paths ?? {}).some((path) =>
      path.startsWith("/api/intake/execution/"),
    ),
    false,
  );
  assert.equal(
    Object.keys(resolved.paths ?? {}).some((path) =>
      path.startsWith("/api/intake/storage/"),
    ),
    false,
  );
});

test("published outbound request reads are human unary routes", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const list = resolved.paths?.["/api/intake/outbound"]?.get as
    ResolvedOperation | undefined;
  const get = resolved.paths?.["/api/intake/outbound/{outbound_request_id}"]
    ?.get as ResolvedOperation | undefined;
  assert.equal(list?.operationId, intakeOperations["outbound.request.list"].id);
  assert.equal(list?.["x-access-policy"], AccessPolicy.Human);
  assert.equal(get?.operationId, intakeOperations["outbound.request.get"].id);
  assert.equal(get?.["x-access-policy"], AccessPolicy.Human);
});

test("published outbound request discard and delete are human mutation routes", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const discard = resolved.paths?.[
    "/api/intake/outbound/{outbound_request_id}/discard"
  ]?.post as ResolvedOperation | undefined;
  const remove = resolved.paths?.["/api/intake/outbound/delete"]?.post as
    ResolvedOperation | undefined;
  assert.equal(
    discard?.operationId,
    intakeOperations["outbound.request.discard"].id,
  );
  assert.equal(discard?.["x-access-policy"], AccessPolicy.Human);
  assert.equal(
    remove?.operationId,
    intakeOperations["outbound.request.delete"].id,
  );
  assert.equal(remove?.["x-access-policy"], AccessPolicy.Human);
});

test("published inbound event retry and discard are human mutation routes", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const retry = resolved.paths?.["/api/intake/event/{inbound_event_id}/retry"]
    ?.post as ResolvedOperation | undefined;
  const discard = resolved.paths?.[
    "/api/intake/event/{inbound_event_id}/discard"
  ]?.post as ResolvedOperation | undefined;
  assert.equal(retry?.operationId, intakeOperations["inbound.event.retry"].id);
  assert.equal(retry?.["x-access-policy"], AccessPolicy.Human);
  assert.equal(
    discard?.operationId,
    intakeOperations["inbound.event.discard"].id,
  );
  assert.equal(discard?.["x-access-policy"], AccessPolicy.Human);
});

test("published inbound create is a human mutation route with a 201 inbound", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const create = resolved.paths?.["/api/intake/inbound"]?.post as
    | (ResolvedOperation & {
        responses?: Record<
          number,
          { content?: Record<string, { schema: ResolvedSchema }> }
        >;
      })
    | undefined;
  assert.equal(create?.operationId, intakeOperations["inbound.create"].id);
  assert.equal(create?.["x-access-policy"], AccessPolicy.Human);
  const created = create?.responses?.[INBOUND_CREATED];
  assert.deepEqual(
    Object.keys(
      created?.content?.["application/json"]?.schema.properties ?? {},
    ).sort(),
    [
      "checkpoint",
      "configuration",
      "consumer",
      "created_at",
      "credential",
      "id",
      "kind",
      "platform",
      "project_id",
    ],
  );
});

test("inbound create answers 201, replays a repeated key, refuses an unknown consumer and a machine identity", async (t) => {
  const fixture = await gatewayFixture(t);
  const authorization = `Bearer ${fixture.token}`;
  const post = (path: string, key: string, body: unknown) =>
    fixture.request(path, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify(body),
    });
  const project = projectOperations.create.output.parse(
    await (
      await post(projectOperations.create.path, ulid(), { name: "inbounds" })
    ).json(),
  );
  const webhook = {
    project_id: project.id,
    kind: "webhook",
    platform: "github",
    consumer: "mission.delivery.admit",
    configuration: { resource: "owner/repo" },
  } as const;
  const path = intakeOperations["inbound.create"].path;
  const key = ulid();
  const first = await post(path, key, webhook);
  assert.equal(first.status, INBOUND_CREATED);
  const inbound = intakeOperations["inbound.create"].output.parse(
    await first.json(),
  );
  const repeat = await post(path, key, webhook);
  assert.equal(repeat.status, INBOUND_CREATED);
  assert.deepEqual(
    intakeOperations["inbound.create"].output.parse(await repeat.json()),
    inbound,
  );
  const inboundCount = () =>
    fixture.store.transaction(
      (tx) =>
        (
          tx.database
            .prepare("SELECT COUNT(*) AS total FROM intake_inbound")
            .get() as { total: number }
        ).total,
    );
  assert.equal(inboundCount(), INBOUND_ONE_ROW);
  const consumer = await post(path, ulid(), {
    ...webhook,
    consumer: "mission.node.check",
  });
  assert.equal(consumer.status, HttpStatus.BadRequest);
  assert.equal(
    errorSchema.parse(await consumer.json()).error.code,
    INBOUND_VALIDATION_FAILED,
  );
  const machine = await directClient(intakeOperations, fixture.invocation)[
    "inbound.create"
  ](
    { params: {}, query: {}, body: webhook },
    {
      identity: testMachineIdentity(
        {
          clientId: createIdentity("client_identity"),
          name: "harness",
          resourceIdentity: "worker:kanthord:binding",
          issuedAt: Date.now(),
          projectId: project.id,
        },
        ulid(),
      ),
      idempotencyKey: ulid(),
    },
  );
  assert.equal(machine.type, OperationResultType.Failure);
  if (machine.type !== OperationResultType.Failure) return;
  assert.equal(machine.status, HttpStatus.Unauthorized);
  assert.equal(machine.error.error.code, INBOUND_UNAUTHORIZED);
  assert.equal(inboundCount(), INBOUND_ONE_ROW);
});

test("published inbound reads are human unary routes", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const list = resolved.paths?.["/api/intake/inbound"]?.get as
    ResolvedOperation | undefined;
  const get = resolved.paths?.["/api/intake/inbound/{inbound_id}"]?.get as
    ResolvedOperation | undefined;
  assert.equal(list?.operationId, intakeOperations["inbound.list"].id);
  assert.equal(list?.["x-access-policy"], AccessPolicy.Human);
  assert.equal(get?.operationId, intakeOperations["inbound.get"].id);
  assert.equal(get?.["x-access-policy"], AccessPolicy.Human);
});

test("inbound get answers the webhook secret over HTTP, refuses another prefix and logs no secret", async (t) => {
  const fixture = await gatewayFixture(t);
  const authorization = `Bearer ${fixture.token}`;
  const project = projectOperations.create.output.parse(
    await (
      await fixture.request(projectOperations.create.path, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": ulid(),
        },
        body: JSON.stringify({ name: "inbound-reads" }),
      })
    ).json(),
  );
  const created = await fixture.request(
    intakeOperations["inbound.create"].path,
    {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        "Idempotency-Key": ulid(),
      },
      body: JSON.stringify({
        project_id: project.id,
        kind: "webhook",
        platform: "github",
        consumer: "mission.delivery.admit",
        configuration: { resource: "owner/repo" },
      }),
    },
  );
  assert.equal(created.status, INBOUND_CREATED);
  const inbound = intakeOperations["inbound.create"].output.parse(
    await created.json(),
  );
  const read = (path: string) =>
    fixture.request(path, { headers: { Authorization: authorization } });
  const got = await read(`/api/intake/inbound/${inbound.id}`);
  assert.equal(got.status, HttpStatus.OK);
  const answer = webhookInboundSchema.parse(await got.json());
  assert.equal(answer.address, `/hooks/${inbound.id}`);
  const listed = await read(
    `/api/intake/inbound?project_id=${project.id}&kind=webhook`,
  );
  assert.equal(listed.status, HttpStatus.OK);
  const page = intakeOperations["inbound.list"].output.parse(
    await listed.json(),
  );
  assert.deepEqual(
    page.items.map((item) => item.id),
    [inbound.id],
  );
  const other = await read(
    `/api/intake/inbound/${createIdentity("outbound_request")}`,
  );
  assert.equal(other.status, HttpStatus.BadRequest);
  assert.equal(
    errorSchema.parse(await other.json()).error.code,
    INBOUND_VALIDATION_FAILED,
  );
  assert.ok(fixture.logs.length > INBOUND_NO_LOGS);
  for (const line of fixture.logs)
    assert.equal(line.includes(answer.secret), false);
});

test("published inbound delete is a human route with a bodyless 204 response", async () => {
  const resolved = await SwaggerParser.dereference(openapiPath());
  const remove = resolved.paths?.["/api/intake/inbound/{inbound_id}"]
    ?.delete as ResolvedOperation | undefined;
  assert.equal(remove?.operationId, intakeOperations["inbound.delete"].id);
  assert.equal(remove?.["x-access-policy"], AccessPolicy.Human);
  const fragment = parse(
    readFileSync(
      join(dirname(openapiPath()), "openapi/intake/inbound.delete.yaml"),
      "utf8",
    ),
  );
  assert.equal(fragment.pathItem.delete["x-mutation"], true);
  assert.equal(
    fragment.pathItem.delete.responses[HttpStatus.NoContent].content,
    undefined,
  );
});

test("inbound delete answers 204 over HTTP and 404 for a repeat", async (t) => {
  const fixture = await gatewayFixture(t);
  const authorization = `Bearer ${fixture.token}`;
  const project = projectOperations.create.output.parse(
    await (
      await fixture.request(projectOperations.create.path, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": ulid(),
        },
        body: JSON.stringify({ name: "inbound-deletes" }),
      })
    ).json(),
  );
  const inbound = intakeOperations["inbound.create"].output.parse(
    await (
      await fixture.request(intakeOperations["inbound.create"].path, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          "Idempotency-Key": ulid(),
        },
        body: JSON.stringify({
          project_id: project.id,
          kind: "webhook",
          platform: "github",
          consumer: "mission.delivery.admit",
          configuration: { resource: "owner/repo" },
        }),
      })
    ).json(),
  );
  const path = `/api/intake/inbound/${inbound.id}`;
  const remove = () =>
    fixture.request(path, {
      method: "DELETE",
      headers: { Authorization: authorization, "Idempotency-Key": ulid() },
    });
  const deleted = await remove();
  assert.equal(deleted.status, HttpStatus.NoContent);
  assert.equal(await deleted.text(), INBOUND_EMPTY_BODY);
  for (const response of [
    await fixture.request(path, { headers: { Authorization: authorization } }),
    await remove(),
  ]) {
    assert.equal(response.status, HttpStatus.NotFound);
    assert.equal(
      errorSchema.parse(await response.json()).error.code,
      INBOUND_NOT_FOUND,
    );
  }
});

test("delivery admission has no HTTP route and no OpenAPI operation", async (t) => {
  const operation = missionOperations["delivery.admit"];
  assert.equal(routedOperationIds.has(operation.id), false);
  const resolved = await SwaggerParser.dereference(openapiPath());
  const published = Object.values(resolved.paths ?? {}).flatMap((path) =>
    Object.values(path ?? {})
      .filter((item) => isObject(item) && "operationId" in item)
      .map((item) => (item as ResolvedOperation).operationId),
  );
  assert.equal(published.includes(operation.id), false);
  assert.equal(
    Object.keys(resolved.paths ?? {}).includes(operation.path),
    false,
  );
  const fixture = await gatewayFixture(t);
  const response = await fixture.request(operation.path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": ulid(),
    },
    body: JSON.stringify({}),
  });
  assert.equal(response.status, HttpStatus.NotFound);
  await response.body?.cancel();
});
