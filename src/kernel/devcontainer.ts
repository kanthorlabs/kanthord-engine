import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { z } from "zod";
import { isObject, isString } from "./values.ts";

export const DEVCONTAINER_FILE = ".devcontainer/devcontainer.json";
export const DEVCONTAINER_DIRECTORY = ".devcontainer";
const SINGLE_QUOTE = /'/g;
const QUOTED_SINGLE_QUOTE = "'\\''";

const commandSchema = z.union([z.string().min(1), z.array(z.string()).min(1)]);
export const lifecycleCommandSchema = z.union([
  commandSchema,
  z.record(z.string(), commandSchema),
]);
export type LifecycleCommand = z.infer<typeof lifecycleCommandSchema>;

export const environmentSchema = z.looseObject({
  image: z.string().min(1).optional(),
  build: z
    .looseObject({
      dockerfile: z.string().min(1).optional(),
      context: z.string().min(1).optional(),
    })
    .optional(),
  features: z.record(z.string(), z.unknown()).optional(),
  containerEnv: z.record(z.string(), z.string()).optional(),
  remoteEnv: z.record(z.string(), z.string().nullable()).optional(),
  onCreateCommand: lifecycleCommandSchema.optional(),
  updateContentCommand: lifecycleCommandSchema.optional(),
  postCreateCommand: lifecycleCommandSchema.optional(),
});
export type Environment = z.infer<typeof environmentSchema>;

export type ParsedEnvironment =
  { document: Environment; error: null } | { document: null; error: string };

export function parseEnvironmentText(text: string): ParsedEnvironment {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  const syntax = errors[0];
  if (syntax !== undefined)
    return {
      document: null,
      error: `invalid JSON: ${printParseErrorCode(syntax.error)} at offset ${syntax.offset}`,
    };
  if (!isObject(value) || Array.isArray(value))
    return { document: null, error: "the environment is not a JSON object" };
  const parsed = environmentSchema.safeParse(value);
  if (!parsed.success)
    return {
      document: null,
      error: `invalid environment: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    };
  return { document: parsed.data, error: null };
}

function shellQuoted(word: string): string {
  return `'${word.replace(SINGLE_QUOTE, QUOTED_SINGLE_QUOTE)}'`;
}

function scriptOf(command: z.infer<typeof commandSchema>): string {
  return Array.isArray(command) ? command.map(shellQuoted).join(" ") : command;
}

export function lifecycleScripts(
  command: LifecycleCommand | undefined,
): string[] {
  if (command === undefined) return [];
  if (isString(command) || Array.isArray(command)) return [scriptOf(command)];
  return Object.values(command).map(scriptOf);
}

export function setupScriptsOf(document: Environment): string[] {
  return [
    ...lifecycleScripts(document.updateContentCommand),
    ...lifecycleScripts(document.postCreateCommand),
  ];
}
