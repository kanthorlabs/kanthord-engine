import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkPrompt } from "./prompt-composer.ts";

test("work prompts retain commands and exact text with pinned ownership", () => {
  const work = renderWorkPrompt({
    nodeId: "node",
    revision: 3,
    content: {
      name: "unit",
      requirement: "build",
      criterion: "passes",
      verifications: ["first", "second"],
    },
  });
  assert.match(work.text, /1\. first\n2\. second$/);
  assert.match(work.marked, /owner="node revision 3 of node"/);
  assert.match(work.digest, /^[a-f0-9]{64}$/);
});
