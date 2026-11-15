import assert from "node:assert/strict";
import { test } from "node:test";
import { leadingMention, MentionKind } from "./conversation.ts";

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
