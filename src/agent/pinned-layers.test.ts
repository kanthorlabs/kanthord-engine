import assert from "node:assert/strict";
import { test } from "node:test";
import { contentText, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { openTestSession, redactionOf } from "./redaction-test-support.ts";
import { pinnedLayers } from "./pinned-layers.ts";

const SYSTEM_PROMPT = "owned system";
const WORK_TEXT = "the pinned work text";
const USER_ROLE = "user";
const PROMPT_CALL_COUNT = 3;

function hasSystemPrompt(systemPrompt: string | undefined): boolean {
  return systemPrompt === SYSTEM_PROMPT;
}

function hasWork(messages: readonly unknown[]): boolean {
  return messages.some(
    (m) =>
      (m as { role: string }).role === USER_ROLE &&
      contentText((m as { content: unknown }).content) === WORK_TEXT,
  );
}

test("each agent-loop request and each compaction summary request holds the system prompt pin and the work pin", async (t) => {
  const { redaction } = redactionOf([]);
  const pins = pinnedLayers();

  const { session, scripted } = await openTestSession(t, {
    script: [
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("summary"),
    ],
    redaction,
    gates: [pins.hook],
  });

  pins.pinInference(session, SYSTEM_PROMPT);
  pins.setWork({ text: WORK_TEXT });

  await session.prompt("hello", { expandPromptTemplates: false });
  await session.waitForIdle();

  await session.prompt("world", { expandPromptTemplates: false });
  await session.waitForIdle();

  await session.compact();

  assert.equal(scripted.calls.length, PROMPT_CALL_COUNT);

  for (const call of scripted.calls) {
    assert.ok(
      hasSystemPrompt(call.systemPrompt),
      `call missing system prompt: ${JSON.stringify(call.systemPrompt)}`,
    );
    assert.ok(
      hasWork(call.messages),
      `call missing work pin: ${JSON.stringify(call.messages.map((m) => (m as { role: string }).role))}`,
    );
  }
});
