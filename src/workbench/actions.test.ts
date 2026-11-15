import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { llmOperations } from "../llm/contract.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { projectOperations } from "../project/contract.ts";
import {
  ACTION_CARD_OPERATIONS,
  ActionTarget,
  offerActionTool,
  TARGET_READS,
} from "./actions.ts";

const CARD_ACT_IDS = Object.keys(ACTION_CARD_OPERATIONS);
const CARD_ACT_COUNT = 11;
const PROMPT_PATH = new URL(
  "../../static/prompt/workbench.md",
  import.meta.url,
);

function tool() {
  return offerActionTool({
    operations: [],
    invoke: () => Promise.reject(new Error("no read expected")),
    requester: () => undefined,
    offer: { taken: () => false, append: () => undefined },
  });
}

test("(happy path) the offer_action schema lists exactly the card act ids", () => {
  const { properties } = tool().parameters as unknown as {
    properties: { operation_id: { enum: string[] } };
  };
  assert.equal(CARD_ACT_IDS.length, CARD_ACT_COUNT);
  assert.deepEqual(properties.operation_id.enum, CARD_ACT_IDS);
});

test("(happy path) the offer_action description names every card act", () => {
  const { description } = tool();
  for (const id of CARD_ACT_IDS) assert.ok(description.includes(id), id);
});

test("(happy path) the workbench prompt lists every card act", () => {
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  assert.ok(
    prompt.includes(
      `These acts have an action card: ${CARD_ACT_IDS.map((id) => `\`${id}\``).join(", ")}.`,
    ),
  );
});

test("(security) an id outside the set fails with operation_refused and records nothing", async () => {
  const records: unknown[] = [];
  const offerTool = offerActionTool({
    operations: [],
    invoke: () => Promise.reject(new Error("no read expected")),
    requester: () => undefined,
    offer: { taken: () => false, append: (record) => records.push(record) },
  });
  for (const operation_id of [
    "mission.node.retire",
    "workbench.session.approve",
    "toString",
  ])
    await assert.rejects(
      offerTool.execute(
        "call_1",
        { operation_id, target_id: "node_X" },
        undefined,
        undefined,
        undefined as never,
      ),
      /^Error: workbench\.action\.operation_refused:/,
      operation_id,
    );
  assert.deepEqual(records, []);
});

test("(security) a credential read with no live revision throws target_refused and appends no record", async () => {
  const records: unknown[] = [];
  const rotate = llmOperations.rotate.id;
  const get = TARGET_READS[ActionTarget.Credential].operation_id;
  const offerTool = offerActionTool({
    operations: [{ id: get } as never],
    invoke: () =>
      Promise.resolve({
        type: OperationResultType.Completed,
        data: {
          revisions: [
            { revision: 1, ended_at: 1 },
            { revision: 2, ended_at: 2 },
          ],
        },
      } as never),
    requester: () => ({}) as never,
    offer: { taken: () => false, append: (record) => records.push(record) },
  });
  await assert.rejects(
    offerTool.execute(
      "call_1",
      { operation_id: rotate, target_id: "anthropic-main" },
      undefined,
      undefined,
      undefined as never,
    ),
    /^Error: workbench\.action\.target_refused:/,
  );
  assert.deepEqual(records, []);
});

test("(happy path) the offer_action result tells the agent to write the full answer", async () => {
  const operation_id = projectOperations["bindingSet.write"].id;
  const target_id = "project_X";
  const get = TARGET_READS[ActionTarget.BindingSet].operation_id;
  const offerTool = offerActionTool({
    operations: [{ id: get } as never],
    invoke: () =>
      Promise.resolve({
        type: OperationResultType.Completed,
        data: { version: 1 },
      } as never),
    requester: () => ({}) as never,
    offer: { taken: () => false, append: () => undefined },
  });
  const result = await offerTool.execute(
    "call_1",
    { operation_id, target_id },
    undefined,
    undefined,
    undefined as never,
  );
  assert.deepEqual(result.content, [
    {
      type: "text",
      text: `Card shown: ${operation_id} on ${target_id}. The owner decides. Do not state that the act ran. Now write the full answer: the report that the human asked for, then one sentence about the card.`,
    },
  ]);
});

test("(happy path) the workbench prompt tells the agent to write the full answer after the card", () => {
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  assert.ok(
    prompt.includes(
      "Call `offer_action` at most once per answer, as your last tool call. After the card, write the full answer: the report that the human asked for, then one sentence about the card.",
    ),
  );
});

test("(happy path) the workbench prompt maps each fix case to its setup act", () => {
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  assert.ok(
    prompt.includes(
      "- For a fix case, offer this setup act: `llm.credential.rotate` for `credential_refused`, `project.bindingSet.write` for `no_taker`, `agent.enablement.put` for `agent_invalid` and `request_rejected`. A `request_rejected` stop (`bad_request`) means that the provider refused the request itself. Its fix is in the agent configuration: the model identifier, the reasoning effort or the provider.",
    ),
  );
});

test("(security) the workbench prompt forbids repeating a secret that the human sent", () => {
  const prompt = readFileSync(PROMPT_PATH, "utf8");
  assert.ok(
    prompt.includes(
      "Never ask the human for a secret, and never accept one in the chat. Never repeat a secret that the human sent.",
    ),
  );
});
