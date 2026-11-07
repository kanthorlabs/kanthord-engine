import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  audit,
  FileKind,
  readPrivate,
  writePrivate,
} from "../../kernel/files.ts";
import { decodeX25519Key } from "../../kernel/hpke.ts";
import { directories } from "../../kernel/xdg.ts";
import { parseMapping } from "../../kernel/yaml.ts";
import {
  instanceNameSchema,
  type MachineConfiguration,
  machineConfigurationSchema,
} from "../../worker/contract.ts";

export const MACHINE_CONFIG_VARIABLE = "KANTHORD_MACHINE_CONFIG";
export const CONFIG_INVALID = "worker.machine.config_invalid";
export const CONFIG_ABSENT = "worker.machine.config_absent";
export const CONFIG_CONFLICT = "worker.machine.config_conflict";
export const CONFIG_EXISTS = "cli.worker.machine.config_exists";
const MACHINES_DIRECTORY = "machines";
const FILE_EXTENSION = ".yaml";
const BASE64URL = "base64url";
const UTF8 = "utf8";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function invalid(message: string, path?: string): Diagnostic {
  return new Diagnostic(
    CONFIG_INVALID,
    `worker machine: ${message}`,
    path === undefined ? {} : { fields: [["path", path]] },
  );
}

function refuseName(name: string): void {
  if (!instanceNameSchema.safeParse(name).success)
    throw invalid("the name breaks the binding name form or is reserved.");
}

export function machineFilePath(env: NodeJS.ProcessEnv, name: string): string {
  refuseName(name);
  return join(
    directories(env).config,
    MACHINES_DIRECTORY,
    `${name}${FILE_EXTENSION}`,
  );
}

function parseConfiguration(
  value: unknown,
  path?: string,
): MachineConfiguration {
  const parsed = machineConfigurationSchema.safeParse(value);
  if (!parsed.success || !decodeX25519Key(parsed.data.private_key))
    throw invalid("the configuration fails the configuration schema.", path);
  return parsed.data;
}

export function decodeMachineConfiguration(
  value: string,
): MachineConfiguration {
  const text = value.trim();
  const bytes = Buffer.from(text, BASE64URL);
  if (!BASE64URL_PATTERN.test(text) || bytes.toString(BASE64URL) !== text)
    throw invalid("the value is no unpadded base64url text.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString(UTF8));
  } catch {
    throw invalid("the value is no JSON object.");
  }
  return parseConfiguration(decoded);
}

function readMachineFile(path: string, name: string): MachineConfiguration {
  audit(dirname(path), FileKind.Directory);
  const configuration = parseConfiguration(
    parseMapping(readPrivate(path)),
    path,
  );
  if (configuration.name !== name)
    throw invalid("the name differs from the file name.", path);
  return configuration;
}

function fileExists(path: string): boolean {
  return audit(path, FileKind.File, true);
}

export function readMachineConfiguration(
  env: NodeJS.ProcessEnv,
  name: string,
): MachineConfiguration {
  const path = machineFilePath(env, name);
  const value = env[MACHINE_CONFIG_VARIABLE];
  if (value?.trim()) {
    const configuration = decodeMachineConfiguration(value);
    if (configuration.name !== name)
      throw invalid(
        `${MACHINE_CONFIG_VARIABLE} names another machine than ${name}.`,
      );
    if (fileExists(path))
      throw new Diagnostic(
        CONFIG_CONFLICT,
        `worker machine: ${MACHINE_CONFIG_VARIABLE} is set while the machine file exists.`,
        { fields: [["path", path]] },
      );
    return configuration;
  }
  if (!fileExists(path))
    throw new Diagnostic(
      CONFIG_ABSENT,
      `worker machine: set ${MACHINE_CONFIG_VARIABLE}, or write the machine file with kanthord worker machine join.`,
      {
        fields: [
          ["variable", MACHINE_CONFIG_VARIABLE],
          ["path", path],
        ],
      },
    );
  return readMachineFile(path, name);
}

export function writeMachineFile(
  env: NodeJS.ProcessEnv,
  configuration: MachineConfiguration,
  force: boolean,
): string {
  const path = machineFilePath(env, configuration.name);
  if (!force && fileExists(path))
    throw new Diagnostic(
      CONFIG_EXISTS,
      "worker machine: the machine file exists. Pass --force to overwrite it.",
      { fields: [["path", path]] },
    );
  writePrivate(
    path,
    stringify({
      name: configuration.name,
      private_key: configuration.private_key,
    }),
    force,
  );
  return path;
}
