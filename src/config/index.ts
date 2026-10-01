import assert from "node:assert/strict";
import convict, { type Field, type Schema } from "convict";
import { stringify } from "yaml";
import { dirname, join, resolve } from "node:path";
import { directories } from "../kernel/xdg.ts";
import {
  parseMapping,
  inspectTree,
  MAX_CONFIG_NODES,
  MAX_CONFIG_DEPTH,
} from "../kernel/yaml.ts";
export { directories, type Directories } from "../kernel/xdg.ts";
export { parseMapping } from "../kernel/yaml.ts";
import { randomBytes } from "node:crypto";
import { audit, readPrivate } from "../kernel/files.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { isObject } from "../kernel/values.ts";

import {
  globalConfigSchema,
  MASTER_KEY_BYTES,
  type GlobalConfig,
} from "./global.ts";
import { gatewayConfigSchema, type GatewayConfig } from "../gateway/config.ts";
import { missionConfigSchema, type MissionConfig } from "../mission/config.ts";
import { projectConfigSchema } from "../project/index.ts";
import { workerConfigSchema, type WorkerConfig } from "../worker/config.ts";
const EMPTY_SCHEMA_FIELD_COUNT = 0;
export interface ServerConfig extends GlobalConfig {
  gateway: GatewayConfig;
  mission: MissionConfig;
  worker: WorkerConfig;
}

export function configPath(
  option?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(
    option ??
      env.KANTHORD_CONFIG ??
      join(directories(env).config, "kanthord.yaml"),
  );
}

convict.addParser({ extension: ["yaml", "yml"], parse: parseMapping });

const fragments = {
  gateway: gatewayConfigSchema,
  mission: missionConfigSchema,
  project: projectConfigSchema,
  worker: workerConfigSchema,
};
const schema = {
  ...globalConfigSchema,
  ...Object.fromEntries(
    Object.entries(fragments).filter(
      ([, fragment]) => Object.keys(fragment).length > EMPTY_SCHEMA_FIELD_COUNT,
    ),
  ),
};

function inspectField(
  field: Field,
  value: unknown,
  path: string,
  issues: string[],
): void {
  assert.ok(
    Object.hasOwn(field, "default"),
    "schema fields must declare defaults",
  );
  assert.ok(
    Object.hasOwn(field, "format"),
    "schema fields must declare formats",
  );
  const config = convict({ value: field }, { args: [], env: {} });
  // Convict errors may contain values; collect only schema-owned field names.
  try {
    config.load({ value });
    config.validate({ allowed: "strict" });
  } catch {
    issues.push(`${path}: invalid or missing value.`);
  }
}

function inspect(
  definition: Schema,
  input: unknown,
  prefix: string,
  issues: string[],
): void {
  const entries = Object.entries(definition);
  assert.ok(
    entries.length > EMPTY_SCHEMA_FIELD_COUNT &&
      entries.length <= MAX_CONFIG_NODES,
  );
  assert.ok(
    prefix.split(".").length < MAX_CONFIG_DEPTH,
    "schema nesting is bounded",
  );
  if (!isObject(input) || Array.isArray(input)) {
    issues.push(`${prefix || "configuration"}: expected a mapping.`);
    return;
  }
  const object = input as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.length > entries.length ||
    keys.some((key) => !Object.hasOwn(definition, key))
  )
    issues.push(`${prefix || "configuration"}: undeclared field.`);
  for (const [key, field] of entries) {
    const path = prefix ? `${prefix}.${key}` : key;
    const supplied = Object.hasOwn(object, key);
    if (Object.hasOwn(field, "format"))
      inspectField(
        field as Field,
        supplied ? object[key] : (field as Field).default,
        path,
        issues,
      );
    else inspect(field as Schema, supplied ? object[key] : {}, path, issues);
  }
}

export function configuration(value: unknown) {
  inspectTree(value, { remaining: MAX_CONFIG_NODES }, new Set());
  const issues: string[] = [];
  // Inspect the raw keys before Convict can flatten or discard any of them.
  inspect(schema, value, "", issues);
  if (issues.length)
    throw new Diagnostic("system.config.invalid_field", issues.join("\n"));
  const config = convict<ServerConfig>(schema, { args: [], env: {} });
  // Keep even unexpected load/validation failures from disclosing values.
  try {
    config.load(value);
    config.validate({ allowed: "strict" });
  } catch {
    throw new Diagnostic(
      "system.config.invalid_field",
      "configuration: invalid field.",
    );
  }
  const properties = config.getProperties();
  assert.deepEqual(Object.keys(properties), Object.keys(schema));
  assert.equal(
    Buffer.from(properties.masterKey, "base64").length,
    MASTER_KEY_BYTES,
  );
  return config;
}

export function loadConfig(path: string): ServerConfig {
  if (!audit(path, "file", true))
    throw new Diagnostic(
      "system.config.not_found",
      `${path}: configuration is absent. Run kanthord config init --config ${JSON.stringify(path)}.`,
    );
  audit(dirname(path), "directory");
  return configuration(parseMapping(readPrivate(path))).getProperties();
}

export function initialConfig(): string {
  return stringify(
    configuration({
      masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    }).getProperties(),
  );
}

export function showConfig(path: string): string {
  return stringify(JSON.parse(configuration(loadConfig(path)).toString()));
}
