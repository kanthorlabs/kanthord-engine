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
import { temporary } from "../kernel/test-support.ts";
import { isObject } from "../kernel/values.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
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
import { workbenchOperations } from "./contract.ts";
import { builtinTools, SECRET_OPERATION_IDS, toolOperations } from "./tools.ts";

const TIMEOUT_SECONDS = 20;
const ONE_CHILD = 1;

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
