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
  instanceConfigurationSchema,
  instanceNameSchema,
  type InstanceConfiguration,
} from "../../worker/contract.ts";

export const INSTANCE_CONFIG_VARIABLE = "KANTHORD_WORKER_CONFIG";
export const InstanceConfigSource = { Env: "env", File: "file" } as const;
export type InstanceConfigSource =
  (typeof InstanceConfigSource)[keyof typeof InstanceConfigSource];
export const CONFIG_INVALID = "worker.instance.config_invalid";
export const CONFIG_EXISTS = "cli.worker.join.config_exists";
const WORKERS_DIRECTORY = "workers";
const FILE_EXTENSION = ".yaml";
const BASE64URL = "base64url";
const UTF8 = "utf8";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ResolvedInstance {
  configuration: InstanceConfiguration;
  source: InstanceConfigSource;
}

function invalid(message: string, path?: string): Diagnostic {
  return new Diagnostic(
    CONFIG_INVALID,
    `worker instance: ${message}`,
    path === undefined ? {} : { fields: [["path", path]] },
  );
}

export function instanceFilePath(env: NodeJS.ProcessEnv, name: string): string {
  return join(
    directories(env).config,
    WORKERS_DIRECTORY,
    `${name}${FILE_EXTENSION}`,
  );
}

export function instanceDirectories(
  env: NodeJS.ProcessEnv,
  name: string,
): { data: string; log: string } {
  const named = directories(env);
  return {
    data: join(named.data, WORKERS_DIRECTORY, name),
    log: join(named.state, WORKERS_DIRECTORY, name),
  };
}

function parseConfiguration(
  value: unknown,
  path?: string,
): InstanceConfiguration {
  const parsed = instanceConfigurationSchema.safeParse(value);
  if (!parsed.success || !decodeX25519Key(parsed.data.private_key))
    throw invalid("the configuration fails the configuration schema.", path);
  return parsed.data;
}

export function decodeInstanceConfiguration(
  value: string,
): InstanceConfiguration {
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

function readInstanceFile(path: string, name: string): InstanceConfiguration {
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

export function resolveInstanceConfiguration(
  options: { instance?: string },
  env: NodeJS.ProcessEnv,
): ResolvedInstance {
  const value = env[INSTANCE_CONFIG_VARIABLE];
  if (value?.trim()) {
    const configuration = decodeInstanceConfiguration(value);
    if (
      options.instance !== undefined &&
      options.instance !== configuration.name
    )
      throw invalid("--instance differs from the name of the configuration.");
    const path = instanceFilePath(env, configuration.name);
    if (fileExists(path))
      throw new Diagnostic(
        "worker.start.instance_config_conflict",
        `worker instance: ${INSTANCE_CONFIG_VARIABLE} is set while the instance file exists.`,
        { fields: [["path", path]] },
      );
    return { configuration, source: InstanceConfigSource.Env };
  }
  const path =
    options.instance !== undefined &&
    instanceNameSchema.safeParse(options.instance).success
      ? instanceFilePath(env, options.instance)
      : undefined;
  if (path === undefined || !fileExists(path))
    throw new Diagnostic(
      "worker.start.instance_config_absent",
      `worker instance: set ${INSTANCE_CONFIG_VARIABLE}, or write the instance file with kanthord worker join and pass --instance.`,
      {
        fields: [
          ["variable", INSTANCE_CONFIG_VARIABLE],
          ["path", path ?? null],
          ["xdg_config_home", env.XDG_CONFIG_HOME ?? null],
        ],
      },
    );
  return {
    configuration: readInstanceFile(path, options.instance!),
    source: InstanceConfigSource.File,
  };
}

export function writeInstanceFile(
  env: NodeJS.ProcessEnv,
  configuration: InstanceConfiguration,
  force: boolean,
): string {
  const path = instanceFilePath(env, configuration.name);
  if (!force && fileExists(path))
    throw new Diagnostic(
      CONFIG_EXISTS,
      "worker join: the instance file exists. Pass --force to overwrite it.",
      { fields: [["path", path]] },
    );
  writePrivate(
    path,
    stringify({
      name: configuration.name,
      endpoint: configuration.endpoint,
      instance_id: configuration.instance_id,
      private_key: configuration.private_key,
    }),
    force,
  );
  return path;
}
