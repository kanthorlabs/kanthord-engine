import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { readReleaseFacts } from "./release-facts.ts";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("scripts/release-facts", async (t) => {
  await t.test("reads a forty-character commit of the source tree", () => {
    assert.match(readReleaseFacts(repositoryRoot).commit, /^[0-9a-f]{40}$/);
  });

  await t.test("reads the working-tree state as a boolean", () => {
    assert.equal(typeof readReleaseFacts(repositoryRoot).dirty, "boolean");
  });

  await t.test("reads the tag set as non-empty strings", () => {
    const { tags } = readReleaseFacts(repositoryRoot);

    assert.equal(Array.isArray(tags), true);
    for (const tag of tags) {
      assert.equal(typeof tag, "string");
      assert.equal(tag.length > 0, true);
    }
  });
});
