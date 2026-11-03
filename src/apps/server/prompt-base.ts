import assert from "node:assert/strict";
import { InstructionFileState } from "../../agent/contract.ts";
import type { PromptReaders } from "../../agent/prompt-resolve.ts";
import { OperationError } from "../../kernel/errors.ts";
import {
  type InstructionFileOf,
  ProjectErrorCode,
} from "../../project/contract.ts";

const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  ProjectErrorCode.RepositoryBaseBranchAbsent,
  ProjectErrorCode.RepositorySshUnreachable,
]);

export function projectInstructionFileReader(project: {
  instructionFileOf: InstructionFileOf;
}): PromptReaders["instructionFileOf"] {
  return async (bindingId, commit, path, context) => {
    let file;
    try {
      file = await project.instructionFileOf(bindingId, commit, context);
    } catch (error) {
      if (error instanceof OperationError && UNREACHABLE_CODES.has(error.code))
        return { state: InstructionFileState.Unreachable };
      throw error;
    }
    if (file === null) return { state: InstructionFileState.Absent };
    assert.equal(file.path, path);
    if (file.state !== InstructionFileState.Present)
      return { state: file.state };
    assert.ok(file.text !== null);
    return { state: InstructionFileState.Present, text: file.text };
  };
}
