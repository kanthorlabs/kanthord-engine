import assert from "node:assert/strict";
import { InstructionFileState } from "../agent/contract.ts";
import { InvalidReason, validateText } from "../agent/prompt-source.ts";
import { RepositoryFileState } from "../repository/contract.ts";
import type { RepositoryFile } from "../repository/contract.ts";
import {
  INSTRUCTION_FILE_CACHE_ENTRIES,
  INSTRUCTION_FILE_PATH_MAX_BYTES,
  type InstructionFile,
  InstructionFileReason,
  PromptInvalidReason,
} from "./contract.ts";

const PATH_SEPARATOR = "/";
const PARENT_SEGMENT = "..";
const CURRENT_SEGMENT = ".";
const EMPTY_SEGMENT = "";
const BACKSLASH = "\\";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const READER_REASONS: Record<
  RepositoryFileState,
  InstructionFileReason | null
> = {
  [RepositoryFileState.Present]: null,
  [RepositoryFileState.Absent]: null,
  [RepositoryFileState.NotRegularFile]: null,
  [RepositoryFileState.OutsideRoot]: null,
  [RepositoryFileState.TooLarge]: InstructionFileReason.TooLarge,
  [RepositoryFileState.NotUtf8]: InstructionFileReason.NotUtf8,
  [RepositoryFileState.Unreadable]: InstructionFileReason.Unreadable,
};
const TEXT_REASONS: Partial<Record<InvalidReason, InstructionFileReason>> = {
  [InvalidReason.TooLarge]: InstructionFileReason.TooLarge,
  [InvalidReason.ControlCharacter]: InstructionFileReason.ControlCharacter,
};

export function instructionFilePathReason(path: string): string | null {
  const invalid =
    Buffer.byteLength(path, "utf8") > INSTRUCTION_FILE_PATH_MAX_BYTES ||
    path.includes(BACKSLASH) ||
    CONTROL_CHARACTER.test(path) ||
    path
      .split(PATH_SEPARATOR)
      .some(
        (segment) =>
          segment === EMPTY_SEGMENT ||
          segment === CURRENT_SEGMENT ||
          segment === PARENT_SEGMENT,
      );
  return invalid ? PromptInvalidReason.PathInvalid : null;
}

export function instructionFileFrom(
  file: RepositoryFile,
  commit: string,
): InstructionFile {
  const base = { path: file.path, commit };
  const readerReason = READER_REASONS[file.state];
  if (readerReason !== null)
    return {
      ...base,
      state: InstructionFileState.Invalid,
      reason: readerReason,
      text: null,
    };
  if (file.state !== RepositoryFileState.Present)
    return {
      ...base,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    };
  assert.ok(file.text !== null);
  const invalid = validateText(file.text);
  const reason = invalid === null ? null : (TEXT_REASONS[invalid] ?? null);
  assert.ok(invalid === null || reason !== null);
  return reason === null
    ? {
        ...base,
        state: InstructionFileState.Present,
        reason: null,
        text: file.text,
      }
    : { ...base, state: InstructionFileState.Invalid, reason, text: null };
}

export class InstructionFileCache {
  private readonly entries = new Map<string, InstructionFile>();

  get(
    resourceIdentity: string,
    commit: string,
    path: string,
  ): InstructionFile | undefined {
    const key = JSON.stringify([resourceIdentity, commit, path]);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(resourceIdentity: string, file: InstructionFile): void {
    const key = JSON.stringify([resourceIdentity, file.commit, file.path]);
    this.entries.delete(key);
    this.entries.set(key, file);
    if (this.entries.size <= INSTRUCTION_FILE_CACHE_ENTRIES) return;
    const oldest = this.entries.keys().next();
    assert.ok(!oldest.done);
    this.entries.delete(oldest.value);
  }
}
