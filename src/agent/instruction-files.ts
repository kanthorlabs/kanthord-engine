import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { PROMPT_SOURCE_READ_MS } from "../kernel/prompt-source.ts";
import {
  AgentErrorCode,
  type InstructionFileReader,
  type InstructionFileSource,
  InstructionFileState,
  PromptPart,
  PromptPartState,
  type PromptReference,
} from "./contract.ts";
import type { InstructionFilePart } from "./prompt-render.ts";

export interface InstructionFileTarget {
  binding_id: string;
  name: string;
  commit: string;
}

export type SourceInvalidDetails = Pick<
  PromptReference,
  "part" | "name" | "binding_id" | "path" | "commit"
> & { reason: string };

export function sourceInvalid(details: SourceInvalidDetails): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.PromptSourceInvalid,
    `Prompt source ${details.part} ${details.name} is invalid: ${details.reason}`,
    details,
  );
}

export async function withinPromptDeadline<T>(
  context: Context,
  read: (deadline: Context) => Promise<T>,
): Promise<T> {
  const deadline = new CancellationContext(
    context,
    Date.now() + PROMPT_SOURCE_READ_MS,
  );
  try {
    return await read(deadline);
  } finally {
    deadline.cancel();
  }
}

export function instructionFilePart(
  target: Pick<InstructionFileTarget, "binding_id" | "name">,
  file: InstructionFileSource,
): InstructionFilePart {
  if (file.state === InstructionFileState.Invalid) {
    assert.ok(file.reason);
    throw sourceInvalid({
      part: PromptPart.InstructionFile,
      name: target.name,
      binding_id: target.binding_id,
      path: file.path,
      commit: file.commit,
      reason: file.reason,
    });
  }
  assert.equal(file.state, InstructionFileState.Present);
  assert.ok(file.text !== null);
  return {
    state: PromptPartState.Resolved,
    path: file.path,
    commit: file.commit,
    text: file.text,
  };
}

export async function pinnedInstructionFiles(
  targets: readonly InstructionFileTarget[],
  read: InstructionFileReader,
  context: Context,
): Promise<Map<string, InstructionFilePart>> {
  const files = await withinPromptDeadline(context, (deadline) =>
    Promise.all(
      targets.map(
        async (target) =>
          [
            target,
            await read(target.binding_id, target.commit, deadline),
          ] as const,
      ),
    ),
  );
  const parts = new Map<string, InstructionFilePart>();
  for (const [target, file] of files)
    if (file !== null && file.state !== InstructionFileState.Absent)
      parts.set(target.binding_id, instructionFilePart(target, file));
  return parts;
}
