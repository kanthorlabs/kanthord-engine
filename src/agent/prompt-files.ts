import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { AgentDeclaration } from "./catalog.ts";
import {
  AgentErrorCode,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
} from "./contract.ts";
import { BASE_PROMPT, WORKBENCH_PROMPT } from "./prompt-assets.ts";
import { digest } from "./prompt-composer.ts";
import { readAgentFile, SourceState } from "./prompt-source.ts";

const STANDARD_FILE = "base.md";
const WORKBENCH_FILE = "workbench.md";
const MARKDOWN_EXTENSION = ".md";

interface PromptFile {
  part: PromptPart;
  name: string;
  shipped: string;
}

export interface AgentPromptInput {
  agent: AgentDeclaration;
  directory: string | null;
  workbench: boolean;
  context: Context;
}

export function promptFileInvalid(
  file: string,
  path: string,
  reason: string,
): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.PromptTemplateInvalid,
    `Prompt file ${file} is invalid: ${reason}`,
    { file, path, reason },
  );
}

function promptFiles(
  agent: AgentDeclaration,
  workbench: boolean,
): PromptFile[] {
  return [
    { part: PromptPart.Standard, name: STANDARD_FILE, shipped: BASE_PROMPT },
    {
      part: PromptPart.Role,
      name: `${agent.agent_name}${MARKDOWN_EXTENSION}`,
      shipped: agent.agent_prompt,
    },
    ...(workbench
      ? [
          {
            part: PromptPart.Workbench,
            name: WORKBENCH_FILE,
            shipped: WORKBENCH_PROMPT,
          },
        ]
      : []),
  ];
}

async function resolveFile(
  file: PromptFile,
  directory: string | null,
  context: Context,
): Promise<PromptPartAnswer> {
  const path = directory === null ? null : join(directory, file.name);
  const shipped = {
    part: file.part,
    name: file.name,
    origin: PromptOrigin.Binary,
    path,
    digest: digest(file.shipped),
    text: file.shipped,
  };
  if (path === null) return shipped;
  const read = await readAgentFile(path, { context });
  if (read.state === SourceState.Absent) return shipped;
  if (read.state === SourceState.Invalid)
    throw promptFileInvalid(file.name, path, read.reason);
  return {
    part: file.part,
    name: file.name,
    origin: PromptOrigin.File,
    path,
    digest: digest(read.text),
    text: read.text,
  };
}

export async function resolveAgentPrompt(
  input: AgentPromptInput,
): Promise<PromptPartAnswer[]> {
  assert.ok(input.agent.workbench || !input.workbench);
  const parts: PromptPartAnswer[] = [];
  for (const file of promptFiles(input.agent, input.workbench))
    parts.push(await resolveFile(file, input.directory, input.context));
  return parts;
}
