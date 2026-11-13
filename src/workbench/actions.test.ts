import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ACTION_CARD_OPERATIONS, offerActionTool } from "./actions.ts";

const CARD_ACT_IDS = Object.keys(ACTION_CARD_OPERATIONS);
const CARD_ACT_COUNT = 8;
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

test("(security) an id outside the set fails with operation_refused", async () => {
  await assert.rejects(
    tool().execute(
      "call_1",
      { operation_id: "toString", target_id: "node_X" },
      undefined,
      undefined,
      undefined as never,
    ),
    /^Error: workbench\.action\.operation_refused:/,
  );
});
