import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";

const ENGINE_ROOT = join(import.meta.dirname, "../..");
const PROMPT_DIRECTORY = join(ENGINE_ROOT, "static/prompt");
const PROOF_PATH = join(ENGINE_ROOT, "eval/guard/proof.json");
const GUARD_PROMPT_FILE = /^guard(-[a-z]+)?\.md$/;
const NO_FILES = 0;

const proofSchema = z.object({
  run: z.string(),
  prompts: z.record(z.string(), z.string()),
});

test("the sha256 of each shipped guard prompt file matches the proof of a passing guard eval run", () => {
  const files = readdirSync(PROMPT_DIRECTORY).filter((name) =>
    GUARD_PROMPT_FILE.test(name),
  );
  assert.notEqual(files.length, NO_FILES);
  const proof = proofSchema.parse(JSON.parse(readFileSync(PROOF_PATH, "utf8")));
  for (const file of files) {
    const actual = createHash("sha256")
      .update(readFileSync(join(PROMPT_DIRECTORY, file)))
      .digest("hex");
    assert.equal(proof.prompts[file], actual, file);
  }
});
