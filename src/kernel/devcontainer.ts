import { z } from "zod";
import { isObject, isString } from "./values.ts";

export const DEVCONTAINER_FILE = ".devcontainer/devcontainer.json";
export const DEVCONTAINER_DIRECTORY = ".devcontainer";
export const EnvironmentSource = {
  Stored: "stored",
  Repository: "repository",
  None: "none",
} as const;
export type EnvironmentSource =
  (typeof EnvironmentSource)[keyof typeof EnvironmentSource];
const QUOTE = '"';
const BACKSLASH = "\\";
const SLASH = "/";
const STAR = "*";
const COMMA = ",";
const NEWLINE = "\n";
const BLOCK_END = "*/";
const SEPARATOR = " ";
const CLOSERS = new Set(["}", "]"]);
const WHITESPACE = /\s/;
const NO_COMMA = -1;
const NOT_FOUND = -1;
const ESCAPE_LENGTH = 2;
const COMMENT_START_LENGTH = 2;
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

function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === QUOTE) return index + 1;
    index += char === BACKSLASH ? ESCAPE_LENGTH : 1;
  }
  return text.length;
}

export function jsoncText(text: string): string | null {
  let output = "";
  let comma = NO_COMMA;
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === QUOTE) {
      const end = stringEnd(text, index);
      output += text.slice(index, end);
      comma = NO_COMMA;
      index = end;
    } else if (char === SLASH && next === SLASH) {
      const end = text.indexOf(NEWLINE, index);
      index = end === NOT_FOUND ? text.length : end;
    } else if (char === SLASH && next === STAR) {
      const end = text.indexOf(BLOCK_END, index + COMMENT_START_LENGTH);
      if (end === NOT_FOUND) return null;
      output += SEPARATOR;
      index = end + BLOCK_END.length;
    } else if (WHITESPACE.test(char)) {
      output += char;
      index += 1;
    } else {
      if (CLOSERS.has(char) && comma !== NO_COMMA)
        output = `${output.slice(0, comma)}${SEPARATOR}${output.slice(comma + 1)}`;
      comma = char === COMMA ? output.length : NO_COMMA;
      output += char;
      index += 1;
    }
  }
  return output;
}

export function parseEnvironmentText(text: string): ParsedEnvironment {
  const json = jsoncText(text);
  if (json === null)
    return { document: null, error: "invalid JSON: unterminated comment" };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      document: null,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
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
