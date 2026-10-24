import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { background, CancellationContext } from "../kernel/context.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  InvalidReason,
  PROMPT_SOURCE_MAX_BYTES,
  readAgentFile,
  SourceState,
  validateText,
} from "./prompt-source.ts";

test("prompt sources enforce byte, encoding, control and regular-file rules", async (t) => {
  const root = temporary(t);
  const path = join(root, "base.md");
  const options = { context: background };
  assert.deepEqual(await readAgentFile(path, options), {
    state: SourceState.Absent,
    path,
  });
  for (const [bytes, reason] of [
    [Buffer.from("x".repeat(PROMPT_SOURCE_MAX_BYTES)), null],
    [
      Buffer.from("x".repeat(PROMPT_SOURCE_MAX_BYTES + 1)),
      InvalidReason.TooLarge,
    ],
    [Buffer.from([255]), InvalidReason.NotUtf8],
    [Buffer.from("\u0000"), InvalidReason.ControlCharacter],
    [Buffer.from("\r"), InvalidReason.ControlCharacter],
    [Buffer.from("\u007f"), InvalidReason.ControlCharacter],
    [Buffer.from("\t\n@other.md"), null],
  ] as const) {
    writeFileSync(path, bytes);
    const result = await readAgentFile(path, options);
    assert.deepEqual(
      result,
      reason
        ? { state: SourceState.Invalid, path, reason }
        : { state: SourceState.Present, path, text: bytes.toString("utf8") },
    );
  }
  assert.deepEqual(await readAgentFile(root, options), {
    state: SourceState.Invalid,
    path: root,
    reason: InvalidReason.NotRegularFile,
  });
  assert.equal(
    validateText("é".repeat(PROMPT_SOURCE_MAX_BYTES)),
    InvalidReason.TooLarge,
  );
});

test("a link resolves to its target and a cancelled read answers the deadline", async (t) => {
  const root = temporary(t);
  const directory = join(root, "agents");
  mkdirSync(directory);
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside");
  const link = join(directory, "base.md");
  symlinkSync(outside, link);
  assert.deepEqual(await readAgentFile(link, { context: background }), {
    state: SourceState.Present,
    path: link,
    text: "outside",
  });
  const context = new CancellationContext();
  context.cancel();
  assert.deepEqual(await readAgentFile(outside, { context }), {
    state: SourceState.Invalid,
    path: outside,
    reason: InvalidReason.Deadline,
  });
});
