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
import { createIdentity } from "../kernel/identity.ts";
import { AccessPolicy, type Operation } from "../kernel/operation.ts";
import { ProjectScope } from "../kernel/project-scope.ts";
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
  WORKBENCH_PROJECT_SCOPE_TEXT,
  WorkbenchGuardReason,
  workbenchHumanOnlyText,
  workbenchOperations,
} from "./contract.ts";
import {
  floorOf,
  guardDecision,
  type GuardRun,
  HUMAN_ONLY_OPERATIONS,
} from "./guard.ts";
import { SECRET_OPERATION_IDS } from "./tools.ts";

const NO_OPERATIONS = 0;
const ONE_OPERATION = 1;
const BLOCK_ACTION = "block";
const IMPORT_CONFIRM = {
  action: "confirm",
  guard: { cause: "import", reason: null, confidence: null },
};
const HUMAN_ONLY_COUNT = 91;
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

test("the human-only set holds 90 ids and keeps mission.proposal.decide out", () => {
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
    assert.ok(decision, id);
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
    assert.ok(decision, JSON.stringify(body));
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
    IMPORT_CONFIRM,
  );
  assert.deepEqual(
    floorOf(apply, { params: {}, query: {}, body: { format: "json" } }),
    IMPORT_CONFIRM,
  );
});

const SCOPE_PROJECT = createIdentity("project");
const OTHER_PROJECT = createIdentity("project");
const OWN_NODE = createIdentity("node");
const OWN_MISSION = createIdentity("mission");
const OTHER_NODE = createIdentity("node");
const OTHER_MISSION = createIdentity("mission");
const OWNERS = new Map([
  [OWN_NODE, SCOPE_PROJECT],
  [OWN_MISSION, SCOPE_PROJECT],
  [OTHER_NODE, OTHER_PROJECT],
  [OTHER_MISSION, OTHER_PROJECT],
]);
const GUEST_RUN_CONFIRM = {
  action: "confirm",
  guard: { cause: "guest_run", reason: null, confidence: null },
};
const PROJECT_SCOPE_BLOCK = {
  action: "block",
  reason: WORKBENCH_PROJECT_SCOPE_TEXT,
};
const HUMAN_ACT = {
  reason: "plan",
  expected_mission_version: 1,
  expected_state: "Available",
  expected_attempt: 1,
};
const DIGEST = "0".repeat(64);

function guestRun() {
  let classifierCalls = 0;
  const run: GuardRun = {
    agentName: "ops@1",
    request: "@Yumi pause the node",
    autoMode: () => true,
    classifier: async () => {
      classifierCalls++;
      return null;
    },
    guest: {
      scope: new Set([SCOPE_PROJECT]),
      resolver: new ProjectScope({
        projectOf: (_prefix, id) => OWNERS.get(id) ?? null,
      }),
    },
  };
  return { run, classifierCalls: () => classifierCalls };
}

function nodeAct(nodeId: string) {
  return { params: { node_id: nodeId }, query: {}, body: HUMAN_ACT };
}

function importOf(missionId: string) {
  return {
    params: { mission_id: missionId },
    query: {},
    body: {
      format: "json",
      mission_id: missionId,
      mission_version: 1,
      reason: "plan",
      entries: [],
      preview_digest: DIGEST,
      confirmed_retirements: [],
    },
  };
}

test("(security) layer test 2: an R1 call and an R2 call on an in-scope target of a guest run wait on a card with cause guest_run and reach no classifier", async () => {
  const { run, classifierCalls } = guestRun();
  for (const operation of [
    missionOperations["node.pause"],
    missionOperations["node.block"],
  ])
    assert.deepEqual(
      await guardDecision(operation, nodeAct(OWN_NODE), run),
      GUEST_RUN_CONFIRM,
      operation.id,
    );
  assert.equal(classifierCalls(), NO_OPERATIONS);
});

test("(security) resolver test 15: an R1 call and an import on a target of another project block with project_scope in a guest run", async () => {
  const { run, classifierCalls } = guestRun();
  assert.deepEqual(
    await guardDecision(
      missionOperations["node.pause"],
      nodeAct(OTHER_NODE),
      run,
    ),
    PROJECT_SCOPE_BLOCK,
  );
  assert.deepEqual(
    await guardDecision(
      missionOperations["import.apply"],
      importOf(OTHER_MISSION),
      run,
    ),
    PROJECT_SCOPE_BLOCK,
  );
  assert.equal(classifierCalls(), NO_OPERATIONS);
});

test("(security) resolver test 15: agent.cooldown.clear blocks with project_scope in a guest run", async () => {
  const { run } = guestRun();
  assert.deepEqual(
    await guardDecision(
      agentOperations["cooldown.clear"],
      { params: { credential: "primary" }, query: {} },
      run,
    ),
    PROJECT_SCOPE_BLOCK,
  );
});
