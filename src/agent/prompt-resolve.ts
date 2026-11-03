import assert from "node:assert/strict";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptReference,
} from "./contract.ts";
import { digest } from "./prompt-composer.ts";
import { shippedText } from "./prompt-files.ts";
import { finalPrompt, isFramingTemplate, promptPart } from "./prompt-render.ts";
import { readAgentFile, SourceState } from "./prompt-source.ts";
import { renderTemplate, SHIPPED_TEMPLATES } from "./prompt-templates.ts";

export const InstructionFileState = {
  Present: "present",
  Absent: "absent",
  Invalid: "invalid",
  Unreachable: "unreachable",
} as const;
export type InstructionFileState =
  (typeof InstructionFileState)[keyof typeof InstructionFileState];

export type InstructionFileRead =
  | { state: typeof InstructionFileState.Present; text: string }
  | {
      state: Exclude<InstructionFileState, typeof InstructionFileState.Present>;
    };

export interface PromptReaders {
  agentName: string;
  bindingTextOf(
    bindingId: string,
    part: PromptPart,
    agentName: string,
  ): string | null;
  instructionFileOf(
    bindingId: string,
    commit: string,
    path: string,
    context: Context,
  ): Promise<InstructionFileRead>;
  context: Context;
}

export interface ResolvedPrompt {
  parts: PromptPartAnswer[];
  final: string | null;
}

type Resolution =
  | { state: typeof PromptPartState.Resolved; text: string }
  | {
      state: Exclude<PromptPartState, typeof PromptPartState.Resolved>;
    };

const CHANGED: Resolution = { state: PromptPartState.Changed };
const INVALID: Resolution = { state: PromptPartState.Invalid };
const UNREACHABLE: Resolution = { state: PromptPartState.Unreachable };

function resolved(text: string | null): Resolution {
  return text === null ? CHANGED : { state: PromptPartState.Resolved, text };
}

function renderedFraming(name: string, text: string): Resolution {
  if (!isFramingTemplate(name)) return CHANGED;
  try {
    return resolved(
      renderTemplate({ ...SHIPPED_TEMPLATES, [name]: text }, name, {}),
    );
  } catch (error) {
    if (error instanceof OperationError) return INVALID;
    throw error;
  }
}

async function fileText(
  reference: PromptReference,
  context: Context,
): Promise<Resolution> {
  assert.ok(reference.path);
  const read = await readAgentFile(reference.path, { context });
  if (read.state === SourceState.Absent) return CHANGED;
  if (read.state === SourceState.Invalid) return INVALID;
  return reference.part === PromptPart.Framing
    ? renderedFraming(reference.name, read.text)
    : resolved(read.text);
}

async function instructionFileText(
  reference: PromptReference,
  readers: PromptReaders,
): Promise<Resolution> {
  assert.ok(reference.binding_id);
  assert.ok(reference.commit);
  assert.ok(reference.path);
  const read = await readers.instructionFileOf(
    reference.binding_id,
    reference.commit,
    reference.path,
    readers.context,
  );
  if (read.state === InstructionFileState.Present) return resolved(read.text);
  if (read.state === InstructionFileState.Invalid) return INVALID;
  if (read.state === InstructionFileState.Unreachable) return UNREACHABLE;
  return CHANGED;
}

function textOf(
  reference: PromptReference,
  readers: PromptReaders,
): Promise<Resolution> | Resolution {
  if (reference.origin === PromptOrigin.Binary)
    return resolved(shippedText(reference));
  if (reference.origin === PromptOrigin.File)
    return fileText(reference, readers.context);
  if (reference.origin === PromptOrigin.Repository)
    return instructionFileText(reference, readers);
  assert.equal(reference.origin, PromptOrigin.Database);
  assert.ok(reference.binding_id);
  return resolved(
    readers.bindingTextOf(
      reference.binding_id,
      reference.part,
      readers.agentName,
    ),
  );
}

export async function resolveReference(
  reference: PromptReference,
  readers: PromptReaders,
): Promise<PromptPartAnswer> {
  const resolution = await textOf(reference, readers);
  if (resolution.state !== PromptPartState.Resolved)
    return promptPart(reference, resolution.state, null);
  return digest(resolution.text) === reference.digest
    ? promptPart(reference, PromptPartState.Resolved, resolution.text)
    : promptPart(reference, PromptPartState.Changed, null);
}

export async function resolvePrompt(
  references: readonly PromptReference[],
  readers: PromptReaders,
): Promise<ResolvedPrompt> {
  const parts = await Promise.all(
    references.map((reference) => resolveReference(reference, readers)),
  );
  return { parts, final: finalPrompt(parts) };
}
