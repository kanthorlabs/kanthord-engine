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
  const path = join(root, "AGENTS.md");
  const options = { workspace: root, context: background };
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

test("workspace links stay contained and host links can leave their location", async (t) => {
  const root = temporary(t);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const outside = join(root, "outside.md");
  writeFileSync(outside, "outside");
  const link = join(workspace, "AGENTS.md");
  symlinkSync(outside, link);
  assert.deepEqual(
    await readAgentFile(link, { workspace, context: background }),
    {
      state: SourceState.Invalid,
      path: link,
      reason: InvalidReason.OutsideWorkspace,
    },
  );
  assert.deepEqual(
    await readAgentFile(link, { workspace: null, context: background }),
    { state: SourceState.Present, path: link, text: "outside" },
  );
  const inside = join(workspace, "inside.md");
  writeFileSync(inside, "inside");
  const internalLink = join(workspace, "CLAUDE.md");
  symlinkSync(inside, internalLink);
  assert.deepEqual(
    await readAgentFile(internalLink, { workspace, context: background }),
    { state: SourceState.Present, path: internalLink, text: "inside" },
  );
  const context = new CancellationContext();
  context.cancel();
  assert.deepEqual(await readAgentFile(inside, { workspace, context }), {
    state: SourceState.Invalid,
    path: inside,
    reason: InvalidReason.Deadline,
  });
});
