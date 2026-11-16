import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptTemplate } from "../agent/contract.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../agent/prompt-templates.ts";
import {
  leadingMention,
  MentionKind,
  RELAY_MAX_BYTES,
  relayText,
} from "./conversation.ts";

const NAMES = [
  { agent_name: "software@1", display_name: "Software" },
  { agent_name: "architect@1", display_name: "Software Architecture" },
  { agent_name: "re@1", display_name: "RE" },
];

test("security: H1 an injected name with a space matches the longest name", () => {
  assert.deepEqual(
    leadingMention("@Software Architecture review this", NAMES),
    {
      kind: MentionKind.Known,
      agent_name: "architect@1",
      display_name: "Software Architecture",
      rest: "review this",
    },
  );
});

const ITEM_COUNT = 20;
const ITEM_FILLER_BYTES = 4000;
const FIRST_ITEM = 0;
const LAST_ITEM = ITEM_COUNT - 1;
const FIRST_TIMESTAMP = Date.UTC(2026, 0, 1);
const STEP_MS = 1000;

function humanEntry(index: number) {
  return {
    type: "message",
    id: `entry_${index}`,
    parentId: index === FIRST_ITEM ? null : `entry_${index - 1}`,
    timestamp: new Date(FIRST_TIMESTAMP + index * STEP_MS).toISOString(),
    message: {
      role: "user",
      content: `item-${index} ${"x".repeat(ITEM_FILLER_BYTES)}`,
    },
  };
}

test("security: a relay above RELAY_MAX_BYTES keeps the newest items and starts with the relay text", () => {
  const writer = {
    id: "writer",
    displayName: "RE",
    entries: Array.from({ length: ITEM_COUNT }, (_, index) =>
      humanEntry(index),
    ),
  };
  const reader = { id: "reader", displayName: "Yumi", entries: [] };
  const content = relayText(reader, {
    members: [reader, writer],
    startEntry: null,
    authorName: "Ulrich",
  });
  assert.ok(content);
  assert.ok(Buffer.byteLength(content) <= RELAY_MAX_BYTES);
  assert.ok(
    content.startsWith(
      renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Relay, {}),
    ),
  );
  assert.ok(content.includes(`Ulrich to @RE: item-${LAST_ITEM} `));
  assert.ok(!content.includes(`item-${FIRST_ITEM} `));
});
