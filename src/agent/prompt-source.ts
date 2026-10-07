import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import {
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { InvalidReason, SourceState } from "../worker/contract.ts";
export { InvalidReason, SourceState } from "../worker/contract.ts";

export const PROMPT_SOURCE_MAX_BYTES = 32768;
export const PROMPT_READ_DEADLINE_MS = 10000;
export type SourceRead =
  | { state: typeof SourceState.Present; path: string; text: string }
  | { state: typeof SourceState.Absent; path: string }
  | { state: typeof SourceState.Invalid; path: string; reason: InvalidReason };
const BUFFER_START_OFFSET = 0;
const STRING_TYPE = "string";
const FIRST_PRINTABLE = 32;
const TAB = 9;
const NEWLINE = 10;
const DELETE = 127;
const MISSING = "ENOENT";
const PARENT = "..";

export function validateText(text: string): InvalidReason | null {
  assert.equal(typeof text, STRING_TYPE);
  assert.ok(Number.isSafeInteger(text.length));
  if (Buffer.byteLength(text, "utf8") > PROMPT_SOURCE_MAX_BYTES)
    return InvalidReason.TooLarge;
  for (let index = BUFFER_START_OFFSET; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (
      (code < FIRST_PRINTABLE && code !== TAB && code !== NEWLINE) ||
      code === DELETE
    )
      return InvalidReason.ControlCharacter;
  }
  return null;
}

function invalid(path: string, reason: InvalidReason): SourceRead {
  assert.equal(typeof path, STRING_TYPE);
  assert.ok(Object.values(InvalidReason).includes(reason));
  return { state: SourceState.Invalid, path, reason };
}

async function readBounded(
  path: string,
  workspace: string | null,
  context: Context,
): Promise<SourceRead> {
  throwIfCancelled(context);
  const resolved = await realpath(path);
  if (workspace !== null) {
    const location = relative(await realpath(workspace), resolved);
    if (
      location === PARENT ||
      location.startsWith(`${PARENT}${sep}`) ||
      isAbsolute(location)
    )
      return invalid(path, InvalidReason.OutsideWorkspace);
  }
  throwIfCancelled(context);
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile())
      return invalid(path, InvalidReason.NotRegularFile);
    throwIfCancelled(context);
    const bytes = Buffer.alloc(PROMPT_SOURCE_MAX_BYTES + 1);
    const { bytesRead } = await file.read(
      bytes,
      BUFFER_START_OFFSET,
      bytes.length,
      BUFFER_START_OFFSET,
    );
    assert.ok(bytesRead >= BUFFER_START_OFFSET);
    assert.ok(bytesRead <= bytes.length);
    if (bytesRead > PROMPT_SOURCE_MAX_BYTES)
      return invalid(path, InvalidReason.TooLarge);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(BUFFER_START_OFFSET, bytesRead),
      );
    } catch {
      return invalid(path, InvalidReason.NotUtf8);
    }
    const reason = validateText(text);
    return reason
      ? invalid(path, reason)
      : { state: SourceState.Present, path, text };
  } finally {
    await file.close();
  }
}

export async function readAgentFile(
  path: string,
  options: { workspace: string | null; context: Context },
): Promise<SourceRead> {
  assert.equal(typeof path, STRING_TYPE);
  assert.ok(options.context);
  const context = new CancellationContext(
    options.context,
    Date.now() + PROMPT_READ_DEADLINE_MS,
  );
  try {
    return await Promise.race([
      readBounded(path, options.workspace, context),
      context.done().then(() => invalid(path, InvalidReason.Deadline)),
    ]);
  } catch (error) {
    if (context.err()) return invalid(path, InvalidReason.Deadline);
    if (error instanceof Error && "code" in error && error.code === MISSING)
      return { state: SourceState.Absent, path };
    return invalid(path, InvalidReason.Unreadable);
  } finally {
    context.cancel();
  }
}
