import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptTemplate } from "../agent/contract.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../agent/prompt-templates.ts";
import {
  forkMaterial,
  leadingMention,
  MentionKind,
  mergeEntries,
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

function stamped(id: string, offset: number) {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: new Date(FIRST_TIMESTAMP + offset * STEP_MS).toISOString(),
  };
}

test("invariant: a merge with equal timestamps keeps every entry in member order, then in file order", () => {
  const merged = mergeEntries([
    {
      sessionId: "host",
      agentName: "ops@1",
      entries: [stamped("h1", 0), stamped("h2", 1), stamped("h3", 1)],
    },
    {
      sessionId: "guest",
      agentName: "re@1",
      entries: [stamped("g1", 0), stamped("g2", 1)],
    },
  ]);
  assert.deepEqual(
    merged.map(({ id, session_id }) => [session_id, id]),
    [
      ["host", "h1"],
      ["guest", "g1"],
      ["host", "h2"],
      ["host", "h3"],
      ["guest", "g2"],
    ],
  );
});

test("invariant: a clock that steps back keeps the file order of one member and repeats no entry across two cursor reads", () => {
  const hostEntries = [stamped("h1", 5), stamped("h2", 3)];
  const guestEntries = [stamped("g1", 4)];
  const host = { sessionId: "host", agentName: "ops@1" };
  const guest = { sessionId: "guest", agentName: "re@1" };
  const ids = (entries: ReturnType<typeof mergeEntries>) =>
    entries.map(({ id }) => id);
  const first = mergeEntries([
    { ...host, entries: hostEntries.slice(FIRST_ITEM, 1) },
    { ...guest, entries: [] },
  ]);
  const second = mergeEntries(
    [
      { ...host, entries: hostEntries },
      { ...guest, entries: guestEntries },
    ],
    new Map([["host", "h1"]]),
  );
  assert.deepEqual(ids(first), ["h1"]);
  assert.deepEqual(ids(second), ["h2", "g1"]);
  assert.deepEqual(
    ids(
      mergeEntries([
        { ...host, entries: hostEntries },
        { ...guest, entries: guestEntries },
      ]),
    ),
    ["g1", "h1", "h2"],
  );
});

test("the fork material of a conversation with one owner message holds the owner mark", () => {
  const host = {
    id: "host",
    displayName: "Ops",
    entries: [humanEntry(FIRST_ITEM)],
  };
  const material = forkMaterial({
    members: [host],
    authorName: "Ulrich",
    inProgress: null,
  });
  assert.ok(material.includes("Ulrich (owner) to @Ops: "));
});
