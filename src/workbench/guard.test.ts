import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { agentOperations } from "../agent/contract.ts";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import { footprintOperations } from "../footprint/contract.ts";
import { gatewayOperations } from "../gateway/contract.ts";
import {
  intakeCredentialOperations,
  intakeOperations,
} from "../intake/contract.ts";
import { AccessPolicy, type Operation } from "../kernel/operation.ts";
import { isObject } from "../kernel/values.ts";
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
import {
  WORKBENCH_IMPORT_FORMAT_TEXT,
  WORKBENCH_IMPORT_RETIREMENT_TEXT,
  WorkbenchGuardReason,
  workbenchHumanOnlyText,
  workbenchOperations,
} from "./contract.ts";
import { floorOf, HUMAN_ONLY_OPERATIONS } from "./guard.ts";
import { SECRET_OPERATION_IDS } from "./tools.ts";

const NO_OPERATIONS = 0;
const ONE_OPERATION = 1;
const BLOCK_ACTION = "block";
const HUMAN_ONLY_COUNT = 88;
const HUMAN_ONLY_CODE = "workbench.guard.human_only";
const IMPORT_FORMAT_CODE = "workbench.guard.import_format";
const HUMAN_ONLY_TEXT =
  "workbench.guard.human_only: mission.node.discard is a human-only action. Only the human runs it.";
const RETIREMENT_TEXT =
  "workbench.guard.human_only: mission.import.apply with confirmed_retirements is a human-only action. Import with no retirement, or ask the human to retire the nodes.";
const FORMAT_TEXT =
  "workbench.guard.import_format: Agent imports use format json.";
const FORCE_PROPERTY = "force";
const BODY_PART = "body";
const BRANCH_KEYS = ["anyOf", "oneOf", "allOf"] as const;

const HUMAN_ACCESS: readonly AccessPolicy[] = [
  AccessPolicy.Human,
  AccessPolicy.HumanOrWorker,
  AccessPolicy.HumanOrService,
];

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

function holdsProperty(schema: unknown, name: string): boolean {
  if (!isObject(schema)) return false;
  const { properties } = schema as { properties?: unknown };
  if (isObject(properties) && name in properties) return true;
  return BRANCH_KEYS.some((key) => {
    const branches = (schema as Record<string, unknown>)[key];
    return (
      Array.isArray(branches) &&
      branches.some((branch) => holdsProperty(branch, name))
    );
  });
}

function bodyHoldsForce(operation: Operation): boolean {
  const schema = z.toJSONSchema(operation.input, {
    io: "input",
    unrepresentable: "any",
  }) as { properties?: Record<string, unknown> };
  return holdsProperty(schema.properties?.[BODY_PART], FORCE_PROPERTY);
}

test("(security: authorization) each human-only id names exactly one mutation", () => {
  assert.ok(HUMAN_ONLY_OPERATIONS.size > NO_OPERATIONS);
  for (const id of HUMAN_ONLY_OPERATIONS) {
    const matches = OPERATION_UNION.filter((operation) => operation.id === id);
    assert.equal(
      matches.length,
      ONE_OPERATION,
      `${id} names ${matches.length} operations`,
    );
    assert.ok(matches[0]?.mutation, `${id} is no mutation`);
  }
});

test("(security: authorization) every mutation with a body force is human-only", () => {
  const forced = OPERATION_UNION.filter(
    (operation) => operation.mutation && bodyHoldsForce(operation),
  );
  assert.ok(forced.length > NO_OPERATIONS);
  const missing = forced
    .map(({ id }) => id)
    .filter((id) => !HUMAN_ONLY_OPERATIONS.has(id));
  assert.deepEqual(missing, []);
});

test("(security: authorization, invariant guard) every human mutation is on a tool list or in a guard set", () => {
  const listed = new Set(
    Object.values(AGENT_DECLARATIONS).flatMap(
      (declaration) => declaration.tools.operation,
    ),
  );
  const unclassified = OPERATION_UNION.filter(
    (operation) =>
      operation.mutation &&
      HUMAN_ACCESS.includes(operation.access) &&
      !listed.has(operation.id) &&
      !HUMAN_ONLY_OPERATIONS.has(operation.id) &&
      !SECRET_OPERATION_IDS.has(operation.id) &&
      !operation.secret,
  ).map(({ id }) => id);
  assert.deepEqual(
    unclassified,
    [],
    `unclassified human mutations: ${unclassified.join(", ")}`,
  );
});

test("the guard block reasons and texts are exact", () => {
  assert.equal(WorkbenchGuardReason.HumanOnly, HUMAN_ONLY_CODE);
  assert.equal(WorkbenchGuardReason.ImportFormat, IMPORT_FORMAT_CODE);
  assert.equal(workbenchHumanOnlyText("mission.node.discard"), HUMAN_ONLY_TEXT);
  assert.equal(WORKBENCH_IMPORT_RETIREMENT_TEXT, RETIREMENT_TEXT);
  assert.equal(WORKBENCH_IMPORT_FORMAT_TEXT, FORMAT_TEXT);
});

test("the human-only set holds 88 ids and keeps mission.proposal.decide out", () => {
  assert.equal(HUMAN_ONLY_OPERATIONS.size, HUMAN_ONLY_COUNT);
  assert.ok(
    !HUMAN_ONLY_OPERATIONS.has(missionOperations["proposal.decide"].id),
  );
});

test("(security: refused path) floorOf blocks every human-only id with the human-only code", () => {
  for (const id of HUMAN_ONLY_OPERATIONS) {
    const operation = OPERATION_UNION.find((candidate) => candidate.id === id);
    assert.ok(operation, id);
    const decision = floorOf(operation, { params: {}, query: {}, body: {} });
    assert.equal(decision.action, BLOCK_ACTION, id);
    assert.ok(
      decision.action === BLOCK_ACTION &&
        decision.reason.startsWith(WorkbenchGuardReason.HumanOnly),
      id,
    );
  }
});

test("(security: refused path) floorOf applies the import rules in order", () => {
  const apply = missionOperations["import.apply"];
  const retirement = { confirmed_retirements: ["node_1"] };
  const cases = [
    { body: { format: "json", ...retirement }, text: RETIREMENT_TEXT },
    { body: { format: "markdown", ...retirement }, text: RETIREMENT_TEXT },
    { body: { format: "markdown" }, text: FORMAT_TEXT },
  ];
  for (const { body, text } of cases) {
    const decision = floorOf(apply, { params: {}, query: {}, body });
    assert.equal(decision.action, BLOCK_ACTION, JSON.stringify(body));
    assert.ok(
      decision.action === BLOCK_ACTION && decision.reason === text,
      JSON.stringify(body),
    );
  }
  assert.deepEqual(
    floorOf(apply, {
      params: {},
      query: {},
      body: { format: "json", confirmed_retirements: [] },
    }),
    { action: "confirm" },
  );
  assert.deepEqual(
    floorOf(apply, { params: {}, query: {}, body: { format: "json" } }),
    { action: "confirm" },
  );
});
