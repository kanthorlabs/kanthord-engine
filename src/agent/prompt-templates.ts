import assert from "node:assert/strict";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { Context } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  AgentErrorCode,
  PromptOrigin,
  PromptTemplate,
  type PromptTemplates,
} from "./contract.ts";
import { shippedTemplate } from "./prompt-assets.ts";
import { readAgentFile, SourceState } from "./prompt-source.ts";

export const TEMPLATE_DIRECTORY = "prompts";
export const TemplateInvalidReason = {
  Syntax: "syntax",
  Render: "render",
} as const;
const MARKDOWN_EXTENSION = ".md";
const STRING_TYPE = "string";
const TEMPLATE_NAMES = Object.values(PromptTemplate);

export const SHIPPED_TEMPLATES: PromptTemplates = Object.freeze(
  Object.fromEntries(
    TEMPLATE_NAMES.map((name) => [name, shippedTemplate(name)]),
  ) as Record<PromptTemplate, string>,
);

export type TemplateOrigins = Readonly<Record<PromptTemplate, PromptOrigin>>;
export interface TemplateSet {
  templates: PromptTemplates;
  origins: TemplateOrigins;
}

export const SHIPPED_TEMPLATE_SET: TemplateSet = Object.freeze({
  templates: SHIPPED_TEMPLATES,
  origins: Object.freeze(
    Object.fromEntries(
      TEMPLATE_NAMES.map((name) => [name, PromptOrigin.Binary]),
    ) as Record<PromptTemplate, PromptOrigin>,
  ),
});

const handlebars = Handlebars.create();
handlebars.registerHelper("json", (value: unknown) => JSON.stringify(value));
const COMPILE_OPTIONS = {
  noEscape: true,
  strict: true,
  knownHelpersOnly: true,
  knownHelpers: { json: true },
} as const;

function templateInvalid(
  name: PromptTemplate,
  path: string | null,
  reason: string,
  message: string,
): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    AgentErrorCode.PromptTemplateInvalid,
    `Prompt template ${name} is invalid: ${message}`,
    {
      template: name,
      file: `${TEMPLATE_DIRECTORY}/${name}${MARKDOWN_EXTENSION}`,
      path,
      reason,
    },
  );
}

function checkSyntax(name: PromptTemplate, path: string, text: string): void {
  try {
    handlebars.precompile(text, COMPILE_OPTIONS);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw templateInvalid(
      name,
      path,
      TemplateInvalidReason.Syntax,
      error.message,
    );
  }
}

export function templateDirectory(
  agentDirectory: string | null,
): string | null {
  return agentDirectory === null
    ? null
    : join(agentDirectory, TEMPLATE_DIRECTORY);
}

export async function resolveTemplates(
  directory: string | null,
  context: Context,
): Promise<PromptTemplates> {
  return (await resolveTemplateSet(directory, context)).templates;
}

export async function resolveTemplateSet(
  directory: string | null,
  context: Context,
): Promise<TemplateSet> {
  if (directory === null) return SHIPPED_TEMPLATE_SET;
  const templates: Record<PromptTemplate, string> = { ...SHIPPED_TEMPLATES };
  const origins: Record<PromptTemplate, PromptOrigin> = {
    ...SHIPPED_TEMPLATE_SET.origins,
  };
  for (const name of TEMPLATE_NAMES) {
    const path = join(directory, `${name}${MARKDOWN_EXTENSION}`);
    const read = await readAgentFile(path, { context });
    if (read.state === SourceState.Absent) continue;
    if (read.state === SourceState.Invalid)
      throw templateInvalid(name, path, read.reason, read.reason);
    checkSyntax(name, path, read.text);
    templates[name] = read.text;
    origins[name] = PromptOrigin.File;
  }
  return { templates, origins };
}

export function renderTemplate(
  templates: PromptTemplates,
  name: PromptTemplate,
  values: Readonly<Record<string, unknown>>,
): string {
  const text = templates[name];
  assert.equal(typeof text, STRING_TYPE);
  try {
    return handlebars.compile(text, COMPILE_OPTIONS)(values).trimEnd();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw templateInvalid(
      name,
      null,
      TemplateInvalidReason.Render,
      error.message,
    );
  }
}
