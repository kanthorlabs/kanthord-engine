import assert from "node:assert/strict";
import { test } from "node:test";
import { renderWorkPrompt } from "./prompt-composer.ts";
import { SHIPPED_TEMPLATES } from "./prompt-templates.ts";

test("work prompts retain commands and exact text with no tag", () => {
  const work = renderWorkPrompt(SHIPPED_TEMPLATES, {
    node_id: "node",
    revision: 3,
    content: {
      name: "unit",
      requirement: "build",
      criterion: "passes",
      verifications: ["first", "second"],
    },
  });
  assert.match(work.text, /1\. first\n2\. second$/);
  assert.ok(work.text.startsWith("# unit\n"));
  assert.match(work.digest, /^[a-f0-9]{64}$/);
});

test("work prompts list the repositories only for two or more entries", () => {
  const unit = {
    node_id: "node",
    revision: 1,
    content: {
      name: "unit",
      requirement: "examine",
      criterion: "passes",
      verifications: ["first"],
    },
  };
  const first = { name: "first", directory: "first", base_branch: "main" };
  const second = { name: "second", directory: "second", base_branch: "dev" };
  for (const repositories of [[], [first]])
    assert.match(
      renderWorkPrompt(SHIPPED_TEMPLATES, { ...unit, repositories }).text,
      /1\. first$/,
    );
  assert.match(
    renderWorkPrompt(SHIPPED_TEMPLATES, {
      ...unit,
      repositories: [first, second],
    }).text,
    /## Repositories\n\nRepository first: directory `first`, base branch `main`\nRepository second: directory `second`, base branch `dev`$/,
  );
});
