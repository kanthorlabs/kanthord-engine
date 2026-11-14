import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import { agentOperations } from "../agent/contract.ts";
import { loadPi } from "../agent/pi.ts";
import {
  pidsIn,
  PROCESS_TREE_PIDS,
  processTreeCommand,
  spawnedPids,
  survivingProcesses,
} from "../agent/test-support.ts";
import { createIdentity } from "../kernel/identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { isObject } from "../kernel/values.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
  OperationResultType,
} from "../kernel/operation.ts";
import { footprintOperations } from "../footprint/contract.ts";
import { gatewayOperations } from "../gateway/contract.ts";
import {
  intakeCredentialOperations,
  intakeOperations,
} from "../intake/contract.ts";
import { llmOperations } from "../llm/contract.ts";
import { missionOperations } from "../mission/contract.ts";
import {
  environmentSecretOperations,
  projectOperations,
} from "../project/contract.ts";
import { repositoryOperations } from "../repository/contract.ts";
import { schedulerOperations } from "../scheduler/contract.ts";
import { storageOperations } from "../storage/contract.ts";
import { trackingOperations } from "../tracking/contract.ts";
import { workerOperations } from "../worker/contract.ts";
import { ACTION_CARD_OPERATIONS, ActionTarget } from "./actions.ts";
import { workbenchOperations } from "./contract.ts";
import {
  builtinTools,
  type InvokeOperation,
  operationTool,
  operationToolDeclarations,
  SECRET_OPERATION_IDS,
  toolOperations,
} from "./tools.ts";

const TIMEOUT_SECONDS = 20;
const ONE_CHILD = 1;
const ONE_OPERATION = 1;

test("a workbench bash call that times out leaves no process of its tree", async (t) => {
  const [bash] = builtinTools(
    await loadPi(),
    "swe@1",
    temporary(t),
  ).customTools;
  assert.ok(bash);
  let ready = false;
  const failure: Error = await bash
    .execute(
      "call_bash",
      { command: processTreeCommand(), timeout: TIMEOUT_SECONDS },
      undefined,
      (update) => {
        if (pidsIn(update.content).length === PROCESS_TREE_PIDS) ready = true;
      },
      undefined as never,
    )
    .then(
      () => assert.fail("the bash call ended without a kill"),
      (error: Error) => error,
    );
  assert.ok(ready, "the process tree did not start before the timeout");
  const spawned = spawnedPids(t, [{ type: "text", text: failure.message }]);
  assert.match(failure.message, /Command timed out after 20 seconds/);
  assert.equal(spawned.length, PROCESS_TREE_PIDS);
  assert.deepEqual(await survivingProcesses(spawned), []);
});

test("a background child of a Workbench bash call lives after the call", async (t) => {
  const [bash] = builtinTools(
    await loadPi(),
    "swe@1",
    temporary(t),
  ).customTools;
  assert.ok(bash);
  const result = await bash.execute(
    "call_bash",
    { command: "sleep 30 >/dev/null 2>&1 & echo $!" },
    undefined,
    undefined,
    undefined as never,
  );
  const spawned = spawnedPids(t, result.content);
  assert.equal(spawned.length, ONE_CHILD);
  assert.deepEqual(await survivingProcesses(spawned), spawned);
});

const HUMAN_ACCESS: readonly AccessPolicy[] = [
  AccessPolicy.Human,
  AccessPolicy.HumanOrWorker,
  AccessPolicy.HumanOrService,
];
const PROPERTIES_KEY = "properties";
const NO_OPERATIONS = 0;
const URL_PROPERTIES = ["get_url", "put_url"];

const OPERATION_UNION: Operation[] = [
  gatewayOperations,
  llmOperations,
  repositoryOperations,
  storageOperations,
  workerOperations,
  agentOperations,
  schedulerOperations,
  environmentSecretOperations,
  projectOperations,
  missionOperations,
  intakeOperations,
  intakeCredentialOperations,
  trackingOperations,
  footprintOperations,
  workbenchOperations,
].flatMap((operations) => Object.values(operations) as Operation[]);

function propertyNames(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(propertyNames);
  if (!isObject(schema)) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === PROPERTIES_KEY && isObject(value)
      ? [...Object.keys(value), ...Object.values(value).flatMap(propertyNames)]
      : propertyNames(value),
  );
}

test("(security) every listed id passes the eligibility filter and no list names a secret id", () => {
  const byId = new Map(
    OPERATION_UNION.map((operation) => [operation.id, operation]),
  );
  for (const declaration of Object.values(AGENT_DECLARATIONS))
    for (const id of declaration.tools.operation) {
      const operation = byId.get(id);
      assert.ok(operation, `${declaration.agent_name} lists unknown ${id}`);
      assert.ok(HUMAN_ACCESS.includes(operation.access), id);
      assert.notEqual(operation.lifetime, OperationLifetime.Stream, id);
      assert.ok(!operation.secret, id);
      assert.ok(!SECRET_OPERATION_IDS.has(id), id);
    }
});

test("(security) no operation that toolOperations keeps answers a presigned URL property", () => {
  const kept = toolOperations(
    OPERATION_UNION,
    OPERATION_UNION.map(({ id }) => id),
  );
  assert.ok(kept.length > NO_OPERATIONS);
  for (const operation of kept) {
    const names = propertyNames(
      z.toJSONSchema(operation.output, {
        io: "output",
        unrepresentable: "any",
      }),
    );
    for (const url of URL_PROPERTIES)
      assert.ok(!names.includes(url), `${operation.id} answers ${url}`);
  }
});

const EMPTY_PART_PROPERTIES = 0;
const NULL_TYPE = "null";
const DATA_PARTS = ["params", "query"];

function envelopeSchema(
  operation: Operation,
): Record<string, Record<string, unknown>> {
  const schema = z.toJSONSchema(operation.input, {
    io: "input",
    unrepresentable: "any",
  }) as { properties: Record<string, Record<string, unknown>> };
  return schema.properties;
}

test("no tool schema of ops@1 names a part that carries no data", () => {
  const declarations = operationToolDeclarations(OPERATION_UNION, "ops@1");
  assert.ok(declarations.length > NO_OPERATIONS);
  for (const declaration of declarations) {
    const operation = OPERATION_UNION.find(
      ({ id }) => id.replaceAll(".", "--") === declaration.name,
    );
    assert.ok(operation, declaration.name);
    const full = envelopeSchema(operation);
    const properties = (declaration.input_schema.properties ?? {}) as Record<
      string,
      unknown
    >;
    const required = (declaration.input_schema.required ?? []) as string[];
    const bodiless = full.body?.type === NULL_TYPE;
    assert.equal("body" in properties, !bodiless, `${operation.id} body`);
    for (const part of DATA_PARTS) {
      const empty =
        Object.keys((full[part]?.properties ?? {}) as object).length ===
        EMPTY_PART_PROPERTIES;
      assert.equal(part in properties, !empty, `${operation.id} ${part}`);
    }
    for (const name of required)
      assert.ok(name in properties, `${operation.id} requires ${name}`);
  }
});

test("a tool call of a bodiless operation without body reaches the operation with body null", async () => {
  const operation = missionOperations.get;
  const projectId = createIdentity("project");
  const calls: unknown[] = [];
  const invoke: InvokeOperation = (_target, input) => {
    calls.push(input);
    assert.deepEqual(operation.input.parse(input), input);
    return Promise.resolve({
      type: OperationResultType.Completed,
      status: 200,
      data: { ok: true },
    });
  };
  const tool = operationTool(operation, invoke, () =>
    testHumanIdentity("account", "Account", "token"),
  );
  assert.deepEqual(Object.keys(envelopeProperties(tool.parameters)), [
    "params",
  ]);
  const result = await tool.execute(
    "call_get",
    { params: { project_id: projectId } },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(calls, [
    { params: { project_id: projectId }, query: {}, body: null },
  ]);
  assert.deepEqual(result.details, { ok: true });
});

function envelopeProperties(schema: unknown): object {
  return (schema as { properties: object }).properties;
}

const ACTION_TARGET_KEYS = {
  [ActionTarget.Node]: "node_id",
  [ActionTarget.Project]: "project_id",
  [ActionTarget.Credential]: "credential_name",
  [ActionTarget.BindingSet]: "project_id",
  [ActionTarget.Agent]: "agent_name",
};
const ACTION_CARD_OPERATION_COUNT = 11;
const CREDENTIAL_ROTATE = llmOperations.rotate.id;

test("(security) each action card id is one human mutation without stream or secret, with the key of its target kind", () => {
  const ids = Object.keys(ACTION_CARD_OPERATIONS);
  assert.equal(ids.length, ACTION_CARD_OPERATION_COUNT);
  for (const id of ids) {
    const matches = OPERATION_UNION.filter((operation) => operation.id === id);
    assert.equal(matches.length, ONE_OPERATION, id);
    const [operation] = matches;
    assert.ok(operation);
    assert.equal(
      operation.access,
      id === CREDENTIAL_ROTATE
        ? AccessPolicy.HumanOrWorker
        : AccessPolicy.Human,
      id,
    );
    assert.equal(operation.mutation, true, id);
    assert.notEqual(operation.lifetime, OperationLifetime.Stream, id);
    if (id !== CREDENTIAL_ROTATE) {
      assert.ok(!operation.secret, id);
      assert.ok(!SECRET_OPERATION_IDS.has(id), id);
    }
    const target = ACTION_CARD_OPERATIONS[id];
    assert.ok(target);
    const params = envelopeSchema(operation).params as {
      properties: Record<string, unknown>;
    };
    assert.ok(ACTION_TARGET_KEYS[target] in params.properties, id);
  }
});

test("(security) no tool list of the agent catalog holds workbench.session.action.report", () => {
  const reportId = workbenchOperations["session.action.report"].id;
  for (const declaration of Object.values(AGENT_DECLARATIONS))
    assert.ok(
      !declaration.tools.operation.includes(reportId),
      declaration.agent_name,
    );
});
