import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedaction } from "../redaction.ts";
import {
  installed,
  j,
  providerKey,
  SESSION_ID,
  toolResult,
} from "../redaction-test-support.ts";
import { SensitiveRule } from "../sensitive-text.ts";
import { outputFinding } from "./output-finding.ts";

const FINDINGS = 4;
const NO_WARNING = 0;

async function findingOf(secret: string) {
  const state = createRedaction(async () => [secret], SESSION_ID);
  await state.text("warm up");
  return { state, ...installed([outputFinding(state)]) };
}

test("one assistant message with findings gives one warning with the rule and the count, and stays unchanged", async () => {
  const secret = providerKey();
  const { state, end } = await findingOf(secret);
  const line = j("key ", secret);
  const message = {
    role: "assistant",
    content: [
      { type: "text", text: line },
      { type: "thinking", thinking: line, thinkingSignature: secret },
      {
        type: "toolCall",
        id: "c1",
        name: "bash",
        arguments: { command: line },
      },
    ],
    api: "anthropic-messages",
    timestamp: 1,
  };
  const before = JSON.stringify(message);
  assert.equal(await end(message), undefined);
  assert.equal(JSON.stringify(message), before);
  assert.deepEqual(state.takeWarnings(), [
    { rule: SensitiveRule.LlmCredential, count: FINDINGS },
  ]);
  assert.deepEqual(state.counts().output_found, {
    [SensitiveRule.LlmCredential]: FINDINGS,
  });
  assert.equal(state.takeWarnings().length, NO_WARNING);
});

test("a message with no finding, an errorMessage and an input message give no warning", async () => {
  const secret = providerKey();
  const { state, end } = await findingOf(secret);
  for (const message of [
    {
      role: "assistant",
      content: [{ type: "text", text: "no secret" }],
      api: "anthropic-messages",
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      errorMessage: j("bad key ", secret),
      stopReason: "error",
      timestamp: 1,
    },
    toolResult(j("key ", secret)),
  ])
    assert.equal(await end(message), undefined);
  assert.equal(state.takeWarnings().length, NO_WARNING);
  assert.deepEqual(state.counts().output_found, {});
});
