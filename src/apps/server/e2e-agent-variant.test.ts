import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  AGENT_VARIANT_PREFIX,
  AgentErrorCode,
  agentOperations,
  PromptLayer,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
} from "../../agent/contract.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { createIdempotencyKey, createIdentity } from "../../kernel/identity.ts";
import {
  fakeMachines,
  gatewayFixture,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
} from "./test-support.ts";

const VALIDATION_FAILED = "gateway.request.validation_failed";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const BASE = "ops@1";
const NAME = "Planner";
const INSTRUCTION = "Plan first.";
const NIGHT_OPS = "Night Ops";
const VARIANT_PARTS = [
  PromptPart.Standard,
  PromptPart.Identity,
  PromptPart.Role,
  PromptPart.Variant,
  PromptPart.Workbench,
  PromptPart.Framing,
];
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const MALFORMED_ID = "not-a-variant-id";
const VARIANT_PATH = "/api/agent/variant";
const SWE = "swe@1";
const SWE_PATH = `/api/agent/${SWE}`;
const JSON_HEADERS = { "Content-Type": "application/json" };

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;
type Row = {
  id: string;
  agent_name: string;
  display_name: string;
  instruction: string;
  revision: number;
};
type ErrorBody = { error: { code: string; details: unknown } };

function call(
  fixture: Fixture,
  method: string,
  path: string,
  body?: unknown,
  token: string = fixture.token,
): Promise<Response> {
  return fixture.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...JSON_HEADERS,
      "Idempotency-Key": createIdempotencyKey(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createRow(
  fixture: Fixture,
  name = NAME,
  options: { agentName?: string; instruction?: string } = {},
): Promise<Row> {
  const response = await call(fixture, "POST", VARIANT_PATH, {
    agent_name: options.agentName ?? BASE,
    display_name: name,
    instruction: options.instruction ?? INSTRUCTION,
  });
  assert.equal(response.status, HttpStatus.OK);
  return (await response.json()) as Row;
}

async function errorOf(response: Response): Promise<ErrorBody["error"]> {
  return ((await response.json()) as ErrorBody).error;
}

async function setup(t: TestContext): Promise<Fixture> {
  return gatewayFixture(t, { machines: fakeMachines() });
}

test("the static variant path wins over :agent_name and lists the variants", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture);
  const list = await call(fixture, "GET", VARIANT_PATH);
  assert.equal(list.status, HttpStatus.OK);
  assert.deepEqual(await list.json(), {
    items: [
      {
        id: row.id,
        agent_name: BASE,
        display_name: row.display_name,
        revision: FIRST_REVISION,
      },
    ],
  });
  const declaration = await call(fixture, "GET", SWE_PATH);
  assert.equal(declaration.status, HttpStatus.OK);
  assert.equal(
    ((await declaration.json()) as { agent_name: string }).agent_name,
    SWE,
  );
});

test("create answers the row with revision 1", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture);
  assert.equal(row.revision, FIRST_REVISION);
  assert.equal(row.agent_name, BASE);
  assert.equal(row.display_name, NAME);
  assert.equal(row.instruction, INSTRUCTION);
  assert.match(row.id, new RegExp(`^${AGENT_VARIANT_PREFIX}_`));
});

test("get answers the row", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture);
  const response = await call(fixture, "GET", `${VARIANT_PATH}/${row.id}`);
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), row);
});

test("update answers the row with the same agent_name and the next revision", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture);
  const response = await call(fixture, "PUT", `${VARIANT_PATH}/${row.id}`, {
    display_name: "Reviewer",
    instruction: "Review first.",
    expected_revision: row.revision,
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), {
    id: row.id,
    agent_name: BASE,
    display_name: "Reviewer",
    instruction: "Review first.",
    revision: SECOND_REVISION,
  });
});

test("delete with no session directory answers 200 and a later get answers 404", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture);
  const response = await call(fixture, "DELETE", `${VARIANT_PATH}/${row.id}`, {
    expected_revision: row.revision,
  });
  assert.equal(response.status, HttpStatus.OK);
  assert.deepEqual(await response.json(), { id: row.id });
  const later = await call(fixture, "GET", `${VARIANT_PATH}/${row.id}`);
  assert.equal(later.status, HttpStatus.NotFound);
  assert.equal((await errorOf(later)).code, AgentErrorCode.VariantNotFound);
});

test("(security) a malformed variant_id answers 400 gateway.request.validation_failed", async (t) => {
  const fixture = await setup(t);
  const response = await call(
    fixture,
    "GET",
    `${VARIANT_PATH}/${MALFORMED_ID}`,
  );
  assert.equal(response.status, HttpStatus.BadRequest);
  assert.equal((await errorOf(response)).code, VALIDATION_FAILED);
});

test("(security) an unknown well-formed id answers 404 agent.variant.not_found", async (t) => {
  const fixture = await setup(t);
  const response = await call(
    fixture,
    "GET",
    `${VARIANT_PATH}/${createIdentity(AGENT_VARIANT_PREFIX)}`,
  );
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal((await errorOf(response)).code, AgentErrorCode.VariantNotFound);
});

test("(security) a machine token answers 401 on each variant route", async (t) => {
  const fixture = await setup(t);
  const machine = await fixture.machineToken(
    TEST_PROJECT_ID,
    TEST_WORKER_BINDING,
  );
  const id = createIdentity(AGENT_VARIANT_PREFIX);
  const operations = [
    agentOperations["variant.list"],
    agentOperations["variant.get"],
    agentOperations["variant.create"],
    agentOperations["variant.update"],
    agentOperations["variant.delete"],
  ];
  for (const operation of operations) {
    const response = await call(
      fixture,
      operation.method,
      operation.path.replace(":variant_id", id),
      operation.mutation ? {} : undefined,
      machine,
    );
    assert.equal(response.status, HttpStatus.Unauthorized, operation.id);
    assert.equal((await errorOf(response)).code, UNAUTHORIZED);
  }
});

async function variantPrompt(
  fixture: Fixture,
  row: Row,
): Promise<{ parts: PromptPartAnswer[]; final: string }> {
  const response = await call(
    fixture,
    "GET",
    `/api/agent/${row.agent_name}?variant_id=${row.id}`,
  );
  assert.equal(response.status, HttpStatus.OK);
  return (
    (await response.json()) as {
      prompt: { parts: PromptPartAnswer[]; final: string };
    }
  ).prompt;
}

test("agent.get with variant_id lists the variant part and renders the variant name in identity", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture, NIGHT_OPS);
  const { parts, final } = await variantPrompt(fixture, row);
  assert.deepEqual(
    parts.map(({ part }) => part),
    VARIANT_PARTS,
  );
  const variant = parts.find(({ part }) => part === PromptPart.Variant);
  assert.equal(variant?.layer, PromptLayer.KanthorD);
  assert.equal(variant?.origin, PromptOrigin.Database);
  assert.equal(variant?.state, PromptPartState.Resolved);
  assert.equal(variant?.name, NIGHT_OPS);
  assert.equal(variant?.text, INSTRUCTION);
  const identity = parts.find(({ part }) => part === PromptPart.Identity);
  assert.match(identity?.text ?? "", new RegExp(NIGHT_OPS));
  assert.doesNotMatch(identity?.text ?? "", /Yumi/);
  assert.match(final, new RegExp(INSTRUCTION));
});

test("(security) a template placeholder in the instruction stays literal in the variant part", async (t) => {
  const fixture = await setup(t);
  const instruction = "Call yourself {{display_name}}.";
  const row = await createRow(fixture, NIGHT_OPS, { instruction });
  const { parts } = await variantPrompt(fixture, row);
  assert.equal(
    parts.find(({ part }) => part === PromptPart.Variant)?.text,
    instruction,
  );
});

test("(security) a variant of another agent answers 404 agent.variant.not_found", async (t) => {
  const fixture = await setup(t);
  const row = await createRow(fixture, NIGHT_OPS, { agentName: "re@1" });
  const response = await call(
    fixture,
    "GET",
    `${SWE_PATH}?variant_id=${row.id}`,
  );
  assert.equal(response.status, HttpStatus.NotFound);
  assert.equal((await errorOf(response)).code, AgentErrorCode.VariantNotFound);
});
