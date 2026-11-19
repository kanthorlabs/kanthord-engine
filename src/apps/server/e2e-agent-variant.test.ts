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
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import {
  completed,
  createHost,
  fakeMachines,
  gatewayFixture,
  heldAnswer,
  invitedProjectIds,
  sendMessage,
  TEST_PROJECT_ID,
  TEST_WORKER_BINDING,
  workbenchHarness,
} from "./test-support.ts";

const identity = testHumanIdentity("kanthord", "Ulrich", "agent-variant");
const { workbenchFixture } = workbenchHarness(identity);
const SESSION_TEST_TIMEOUT_MS = 60000;
const GUEST_NAME = "Mira";
const STREAM_PATH = "/api/workbench/guest/session/stream";
const FRAME_END = "\n\n";
const FRAME_PATTERN = /^event: (\w+)\ndata: (.*)$/s;
const STATE_EVENT = "state";
const BASE_CONFIGURATION = {
  agent_provider: "default",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "off",
} as const;
const ANSWER = "Done.";
const CATALOG_NAME = "Yumi";
const NOT_FOUND_INDEX = 0;
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

type WorkbenchFixture = Awaited<ReturnType<typeof workbenchFixture>>;
type StateData = { run_active: boolean; display_name: string | null };

async function variantSessionOf(fixture: WorkbenchFixture) {
  const variant = completed(
    await fixture.agent["variant.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: BASE,
          display_name: NIGHT_OPS,
          instruction: INSTRUCTION,
        },
      },
      fixture.options,
    ),
  );
  const session = completed(
    await fixture.workbench["session.create"](
      {
        params: {},
        query: {},
        body: {
          agent_name: BASE,
          variant_id: variant.id,
          ...BASE_CONFIGURATION,
        },
      },
      fixture.options,
    ),
  );
  return { variant, session };
}

async function nextFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffer: { text: string },
): Promise<{ event: string; data: unknown }> {
  const decoder = new TextDecoder();
  for (;;) {
    const end = buffer.text.indexOf(FRAME_END);
    if (end >= NOT_FOUND_INDEX) {
      const block = buffer.text.slice(0, end);
      buffer.text = buffer.text.slice(end + FRAME_END.length);
      const match = FRAME_PATTERN.exec(block);
      if (match) return { event: match[1]!, data: JSON.parse(match[2]!) };
      continue;
    }
    const chunk = await reader.read();
    assert.equal(chunk.done, false);
    buffer.text += decoder.decode(chunk.value, { stream: true });
  }
}

test(
  "a running variant session answers the variant display_name on the owner feed and the guest feed",
  { timeout: SESSION_TEST_TIMEOUT_MS },
  async (t) => {
    const held = heldAnswer(ANSWER);
    const fixture = await workbenchFixture(
      t,
      [held.step],
      undefined,
      undefined,
      [BASE],
    );
    const { session } = await variantSessionOf(fixture);
    const invited = completed(
      await fixture.workbench["invite.create"](
        {
          params: { session_id: session.id },
          query: {},
          body: {
            invitee_name: GUEST_NAME,
            project_ids: await invitedProjectIds(fixture),
            granted_operations: [],
          },
        },
        fixture.options,
      ),
    );
    const joined = completed(
      await fixture.workbench["invite.join"](
        {
          params: {},
          query: {},
          body: { invite_token: invited.invite_token, name: GUEST_NAME },
        },
        fixture.options,
      ),
    );
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fixture.request(STREAM_PATH, {
      headers: { authorization: `Bearer ${joined.guest_token}` },
      signal: controller.signal,
    });
    assert.equal(response.status, HttpStatus.OK);
    const reader = response.body!.getReader();
    const buffer = { text: "" };
    completed(await sendMessage(fixture, session.id, "@Yumi who are you?"));
    let state: StateData | undefined;
    while (state?.run_active !== true) {
      const frame = await nextFrame(reader, buffer);
      if (frame.event === STATE_EVENT) state = frame.data as StateData;
    }
    assert.equal(state.display_name, NIGHT_OPS);
    const host = fixture.workbenchService["sessions"].get(session.id);
    assert.ok(host);
    assert.equal(
      fixture.workbenchService["feedState"](host).display_name,
      NIGHT_OPS,
    );
    held.gate.resolve();
  },
);

test(
  "a list read with a variant session whose row is gone answers the catalog name",
  { timeout: SESSION_TEST_TIMEOUT_MS },
  async (t) => {
    const fixture = await workbenchFixture(t, [], undefined, undefined, [BASE]);
    const base = await createHost(fixture, BASE);
    const { variant, session } = await variantSessionOf(fixture);
    fixture.workbenchService["dependencies"].store.transaction((tx) =>
      tx.database
        .prepare("DELETE FROM agent_variant WHERE id = ?")
        .run(variant.id),
    );
    const listed = completed(
      await fixture.workbench["session.list"](
        { params: {}, query: {}, body: null },
        fixture.options,
      ),
    );
    const item = listed.items.find(({ id }) => id === session.id);
    assert.equal(item?.display_name, CATALOG_NAME);
    assert.equal(item?.variant_id, variant.id);
    assert.ok(listed.items.some(({ id }) => id === base.id));
  },
);
