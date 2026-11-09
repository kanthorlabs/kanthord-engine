import assert from "node:assert/strict";
import { test } from "node:test";
import { agentPromptSpanId } from "./prompt-telemetry.ts";

const EXECUTION_ID = "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const SPAN_ID_PATTERN = /^[a-f0-9]{16}$/;
const FIRST_AGENT = "swe@1";
const SECOND_AGENT = "re@1";

test("span id is stable for one execution and one agent and differs for two agents", () => {
  const first = agentPromptSpanId(EXECUTION_ID, FIRST_AGENT);
  assert.match(first, SPAN_ID_PATTERN);
  assert.equal(first, agentPromptSpanId(EXECUTION_ID, FIRST_AGENT));
  assert.notEqual(first, agentPromptSpanId(EXECUTION_ID, SECOND_AGENT));
});
