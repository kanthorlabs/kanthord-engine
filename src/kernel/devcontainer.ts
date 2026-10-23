import { posix } from "node:path";
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
const BUILD_KEY = "build";
const FEATURES_KEY = "features";
const KEY_SEPARATOR = ".";
const PARENT_DIRECTORY = "..";
const LOCAL_FEATURE = /^\.{1,2}\//;
const SERVER_VARIABLE = /\$\{(localEnv|env):/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const ALLOWED_KEYS = new Set([
  "image",
  BUILD_KEY,
  FEATURES_KEY,
  "containerEnv",
  "remoteEnv",
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
]);
const BUILD_ALLOWED_KEYS = new Set(["dockerfile", "context", "args", "target"]);
const VARIABLE_KEYS = ["containerEnv", "remoteEnv"] as const;
const DROPPED_KEYS = new Set([
  "$schema",
  "name",
  "customizations",
  "forwardPorts",
  "portsAttributes",
  "otherPortsAttributes",
  "hostRequirements",
  "remoteUser",
  "containerUser",
  "updateRemoteUserUID",
  "userEnvProbe",
  "overrideCommand",
  "shutdownAction",
  "waitFor",
  "postStartCommand",
  "postAttachCommand",
  "workspaceFolder",
]);
export const EnvironmentRefusalReason = {
  KeyNotAllowed: "the key is not allowed",
  ServerVariable: "the value reads a server variable",
  PathOutside: "the path leaves the checkout",
  VariableName: "the variable name is not valid",
  ControlCharacter: "the value holds a control character",
} as const;
export type EnvironmentRefusalReason =
  (typeof EnvironmentRefusalReason)[keyof typeof EnvironmentRefusalReason];
export interface EnvironmentRefusal {
  key: string;
  reason: EnvironmentRefusalReason;
}
type EnvironmentObject = Readonly<Record<string, unknown>>;

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

function refusal(
  key: string,
  reason: EnvironmentRefusalReason,
): EnvironmentRefusal {
  return { key, reason };
}

export function buildDocument(document: EnvironmentObject): Environment {
  return Object.fromEntries(
    Object.entries(document).filter(([key]) => ALLOWED_KEYS.has(key)),
  );
}

export function devcontainerPath(path: string): string {
  return posix.normalize(posix.join(DEVCONTAINER_DIRECTORY, path));
}

export function insideCheckout(path: string): boolean {
  if (posix.isAbsolute(path)) return false;
  const resolved = devcontainerPath(path);
  return (
    resolved !== PARENT_DIRECTORY &&
    !resolved.startsWith(`${PARENT_DIRECTORY}/`)
  );
}

export function isLocalFeature(feature: string): boolean {
  return LOCAL_FEATURE.test(feature) || posix.isAbsolute(feature);
}

export function variableRefusal(
  name: string,
  value: string,
): EnvironmentRefusalReason | null {
  if (!VARIABLE_NAME.test(name)) return EnvironmentRefusalReason.VariableName;
  if (CONTROL_CHARACTER.test(value))
    return EnvironmentRefusalReason.ControlCharacter;
  return null;
}

function keyRefusal(document: EnvironmentObject): EnvironmentRefusal | null {
  for (const key of Object.keys(document))
    if (!ALLOWED_KEYS.has(key) && !DROPPED_KEYS.has(key))
      return refusal(key, EnvironmentRefusalReason.KeyNotAllowed);
  const build = document[BUILD_KEY];
  if (isObject(build))
    for (const key of Object.keys(build))
      if (!BUILD_ALLOWED_KEYS.has(key))
        return refusal(
          `${BUILD_KEY}${KEY_SEPARATOR}${key}`,
          EnvironmentRefusalReason.KeyNotAllowed,
        );
  return null;
}

function serverVariableKey(value: unknown, key: string): string | null {
  if (isString(value)) return SERVER_VARIABLE.test(value) ? key : null;
  if (!isObject(value)) return null;
  for (const [name, entry] of Object.entries(value)) {
    const found = serverVariableKey(entry, `${key}${KEY_SEPARATOR}${name}`);
    if (found !== null) return found;
  }
  return null;
}

function pathRefusal(document: EnvironmentObject): EnvironmentRefusal | null {
  const build = document[BUILD_KEY];
  if (isObject(build))
    for (const key of ["dockerfile", "context"]) {
      const path = (build as Record<string, unknown>)[key];
      if (isString(path) && !insideCheckout(path))
        return refusal(
          `${BUILD_KEY}${KEY_SEPARATOR}${key}`,
          EnvironmentRefusalReason.PathOutside,
        );
    }
  const features = document[FEATURES_KEY];
  if (isObject(features))
    for (const feature of Object.keys(features))
      if (
        isLocalFeature(feature) &&
        (posix.isAbsolute(feature) ||
          !devcontainerPath(feature).startsWith(`${DEVCONTAINER_DIRECTORY}/`))
      )
        return refusal(
          `${FEATURES_KEY}${KEY_SEPARATOR}${feature}`,
          EnvironmentRefusalReason.PathOutside,
        );
  return null;
}

function lineRefusal(document: EnvironmentObject): EnvironmentRefusal | null {
  for (const scope of VARIABLE_KEYS) {
    const variables = document[scope];
    if (!isObject(variables)) continue;
    for (const [name, value] of Object.entries(variables)) {
      if (value === null) continue;
      const reason = variableRefusal(name, String(value));
      if (reason !== null)
        return refusal(`${scope}${KEY_SEPARATOR}${name}`, reason);
    }
  }
  return null;
}

export function environmentRefusal(
  document: EnvironmentObject,
): EnvironmentRefusal | null {
  const kept = buildDocument(document);
  const variable = Object.entries(kept)
    .map(([key, value]) => serverVariableKey(value, key))
    .find((key) => key !== null);
  return (
    keyRefusal(document) ??
    (variable === undefined
      ? null
      : refusal(variable, EnvironmentRefusalReason.ServerVariable)) ??
    pathRefusal(kept) ??
    lineRefusal(kept)
  );
}
