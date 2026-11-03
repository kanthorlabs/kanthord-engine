import assert from "node:assert/strict";
import { InstructionFileState } from "../agent/contract.ts";
import { validateText } from "../agent/prompt-source.ts";
import { RepositoryFileState } from "../repository/contract.ts";
import type { RepositoryFile } from "../repository/contract.ts";
import {
  INSTRUCTION_FILE_CACHE_ENTRIES,
  INSTRUCTION_FILE_PATH_MAX_BYTES,
  type InstructionFile,
  PromptInvalidReason,
} from "./contract.ts";

const PATH_SEPARATOR = "/";
const PARENT_SEGMENT = "..";
const EMPTY_SEGMENT = "";
const BACKSLASH = "\\";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

const ABSENT_STATES: ReadonlySet<RepositoryFileState> = new Set([
  RepositoryFileState.Absent,
  RepositoryFileState.NotRegularFile,
  RepositoryFileState.OutsideRoot,
]);

export function instructionFilePathReason(path: string): string | null {
  const invalid =
    Buffer.byteLength(path, "utf8") > INSTRUCTION_FILE_PATH_MAX_BYTES ||
    path.includes(BACKSLASH) ||
    CONTROL_CHARACTER.test(path) ||
    path
      .split(PATH_SEPARATOR)
      .some(
        (segment) => segment === EMPTY_SEGMENT || segment === PARENT_SEGMENT,
      );
  return invalid ? PromptInvalidReason.PathInvalid : null;
}

export function instructionFileFrom(
  file: RepositoryFile,
  commit: string,
): InstructionFile {
  const base = { path: file.path, commit };
  if (ABSENT_STATES.has(file.state))
    return {
      ...base,
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    };
  if (file.state !== RepositoryFileState.Present)
    return {
      ...base,
      state: InstructionFileState.Invalid,
      reason: file.state,
      text: null,
    };
  assert.ok(file.text !== null);
  const reason = validateText(file.text);
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
