import assert from "node:assert/strict";
import { join } from "node:path";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  type AgentDeclaration,
  getAgentDeclaration,
  workbenchAgentNames,
} from "./catalog.ts";
import {
  AgentErrorCode,
  PromptOrigin,
  PromptPart,
  type PromptPartAnswer,
  PromptPartState,
  type PromptReference,
  PromptTemplate,
} from "./contract.ts";
import { BASE_PROMPT, WORKBENCH_PROMPT } from "./prompt-assets.ts";
import { digest } from "./prompt-composer.ts";
import {
  framing,
  framingTemplate,
  isFramingTemplate,
  type PromptConsumer,
  promptPart,
} from "./prompt-render.ts";
import { readAgentFile, SourceState } from "./prompt-source.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
  templateDirectory,
  type TemplateSet,
} from "./prompt-templates.ts";

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
  templates: TemplateSet;
  directory: string | null;
  workbench: boolean;
  context: Context;
}

function promptFileInvalid(
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

function filePart(
  file: Pick<PromptFile, "part" | "name">,
  origin: PromptOrigin,
  path: string | null,
  text: string,
): PromptPartAnswer {
  return promptPart(
    {
      part: file.part,
      name: file.name,
      origin,
      path,
      binding_id: null,
      commit: null,
      digest: digest(text),
    },
    PromptPartState.Resolved,
    text,
  );
}

async function resolveFile(
  file: PromptFile,
  directory: string | null,
  context: Context,
): Promise<PromptPartAnswer> {
  const path = directory === null ? null : join(directory, file.name);
  const shipped = filePart(file, PromptOrigin.Binary, path, file.shipped);
  if (path === null) return shipped;
  const read = await readAgentFile(path, { context });
  if (read.state === SourceState.Absent) return shipped;
  if (read.state === SourceState.Invalid)
    throw promptFileInvalid(file.name, path, read.reason);
  return filePart(file, PromptOrigin.File, path, read.text);
}

export function framingPart(
  set: TemplateSet,
  consumer: PromptConsumer,
  directory: string | null,
): PromptPartAnswer {
  const name = framingTemplate(consumer);
  const templatesDirectory = templateDirectory(directory);
  return filePart(
    { part: PromptPart.Framing, name },
    set.origins[name],
    templatesDirectory === null
      ? null
      : join(templatesDirectory, `${name}${MARKDOWN_EXTENSION}`),
    framing(set.templates, consumer),
  );
}

export function identityPart(
  set: TemplateSet,
  agent: AgentDeclaration,
  directory: string | null,
): PromptPartAnswer {
  const templatesDirectory = templateDirectory(directory);
  return filePart(
    { part: PromptPart.Identity, name: PromptTemplate.Identity },
    set.origins[PromptTemplate.Identity],
    templatesDirectory === null
      ? null
      : join(
          templatesDirectory,
          `${PromptTemplate.Identity}${MARKDOWN_EXTENSION}`,
        ),
    renderTemplate(set.templates, PromptTemplate.Identity, {
      display_name: agent.display_name,
    }),
  );
}

function shippedRole(name: string): string | null {
  if (!name.endsWith(MARKDOWN_EXTENSION)) return null;
  return (
    getAgentDeclaration(name.slice(0, -MARKDOWN_EXTENSION.length))
      ?.agent_prompt ?? null
  );
}

function shippedIdentity(name: string, agentName: string): string | null {
  const agent = getAgentDeclaration(agentName);
  if (name !== PromptTemplate.Identity || agent === undefined) return null;
  return renderTemplate(SHIPPED_TEMPLATES, PromptTemplate.Identity, {
    display_name: agent.display_name,
  });
}

export function shippedText(
  reference: Pick<PromptReference, "part" | "name">,
  agentName: string,
): string | null {
  const { part, name } = reference;
  if (part === PromptPart.Identity) return shippedIdentity(name, agentName);
  if (part === PromptPart.Framing)
    return isFramingTemplate(name)
      ? renderTemplate(SHIPPED_TEMPLATES, name, {})
      : null;
  if (part === PromptPart.Standard)
    return name === STANDARD_FILE ? BASE_PROMPT : null;
  if (part === PromptPart.Workbench)
    return name === WORKBENCH_FILE ? WORKBENCH_PROMPT : null;
  if (part !== PromptPart.Role) return null;
  return shippedRole(name);
}

export async function resolveAgentPrompt(
  input: AgentPromptInput,
): Promise<PromptPartAnswer[]> {
  assert.ok(
    workbenchAgentNames().includes(input.agent.agent_name) || !input.workbench,
  );
  const parts: PromptPartAnswer[] = [];
  const identified = workbenchAgentNames().includes(input.agent.agent_name);
  for (const file of promptFiles(input.agent, input.workbench)) {
    if (identified && file.part === PromptPart.Role)
      parts.push(identityPart(input.templates, input.agent, input.directory));
    parts.push(await resolveFile(file, input.directory, input.context));
  }
  return parts;
}
