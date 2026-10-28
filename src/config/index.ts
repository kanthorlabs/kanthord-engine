import assert from "node:assert/strict";
import convict, { type Field, type Schema } from "convict";
import { stringify } from "yaml";
import { dirname } from "node:path";
import {
  parseMapping,
  inspectTree,
  MAX_CONFIG_NODES,
  MAX_CONFIG_DEPTH,
} from "../kernel/yaml.ts";
export { directories, type Directories } from "../kernel/xdg.ts";
export { parseMapping } from "../kernel/yaml.ts";
export { configPath } from "./path.ts";
export { CONFIG_VERSION } from "./steps.ts";
import { randomBytes } from "node:crypto";
import { audit, readPrivate } from "../kernel/files.ts";
import { Diagnostic } from "../kernel/errors.ts";
import {
  ABSENT_CONFIG_VERSION,
  CONFIG_VERSION,
  CONFIG_VERSION_FIELD,
} from "./steps.ts";
import { isObject } from "../kernel/values.ts";

import {
  globalConfigSchema,
  MASTER_KEY_BYTES,
  type GlobalConfig,
} from "./global.ts";
import { gatewayConfigSchema, type GatewayConfig } from "../gateway/config.ts";
import { missionConfigSchema, type MissionConfig } from "../mission/config.ts";
import { agentConfigSchema, type AgentConfig } from "../agent/config.ts";
import { projectConfigSchema, type ProjectConfig } from "../project/index.ts";
import { intakeConfigSchema } from "../intake/index.ts";
import { workerConfigSchema, type WorkerConfig } from "../worker/config.ts";
import {
  schedulerConfigSchema,
  type SchedulerConfig,
} from "../scheduler/config.ts";
import {
  trackingConfigSchema,
  type TrackingConfig,
} from "../tracking/config.ts";
const EMPTY_SCHEMA_FIELD_COUNT = 0;
const CONTAINER_INIT_COMMAND =
  "podman run --rm -v <volume>:/var/lib/kanthord docker.io/kanthorlabs/kanthord:<version> config init --gateway-bind :: --gateway-allowed-host localhost:<port> --gateway-allowed-host 127.0.0.1:<port>";
export interface ServerConfig extends GlobalConfig {
  version: number;
  gateway: GatewayConfig;
  mission: MissionConfig;
  project: ProjectConfig;
  agent: AgentConfig;
  worker: WorkerConfig;
  scheduler: SchedulerConfig;
  tracking: TrackingConfig;
}

convict.addParser({ extension: ["yaml", "yml"], parse: parseMapping });

const fragments = {
  gateway: gatewayConfigSchema,
  mission: missionConfigSchema,
  project: projectConfigSchema,
  intake: intakeConfigSchema,
  agent: agentConfigSchema,
  worker: workerConfigSchema,
  scheduler: schedulerConfigSchema,
  tracking: trackingConfigSchema,
};
function isConfigVersion(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= ABSENT_CONFIG_VERSION
  );
}

const versionSchema = {
  [CONFIG_VERSION_FIELD]: {
    doc: "Configuration version. kanthord upgrade sets it.",
    default: ABSENT_CONFIG_VERSION,
    format(value: unknown) {
      if (!isConfigVersion(value))
        throw new Error("required positive safe integer");
    },
  },
};

const schema = {
  ...versionSchema,
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
  const undeclared = Object.keys(object).filter(
    (key) => !Object.hasOwn(definition, key),
  );
  if (undeclared.length)
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

export function configVersion(value: unknown): number {
  const version =
    isObject(value) && Object.hasOwn(value, CONFIG_VERSION_FIELD)
      ? (value as Record<string, unknown>)[CONFIG_VERSION_FIELD]
      : ABSENT_CONFIG_VERSION;
  if (!isConfigVersion(version))
    throw new Diagnostic(
      "system.config.invalid_field",
      "invalid or missing value",
      { fields: [["field", CONFIG_VERSION_FIELD]] },
    );
  if (version > CONFIG_VERSION)
    throw new Diagnostic(
      "system.config.version_ahead",
      "the configuration version is newer than this binary; install a newer kanthord or restore the configuration backup",
      {
        fields: [
          ["config_version", version],
          ["supported_version", CONFIG_VERSION],
        ],
      },
    );
  return version;
}

export function configuration(value: unknown) {
  inspectTree(value, { remaining: MAX_CONFIG_NODES }, new Set());
  const version =
    isObject(value) && !Array.isArray(value)
      ? configVersion(value)
      : CONFIG_VERSION;
  if (version < CONFIG_VERSION)
    throw new Diagnostic(
      "system.config.version_behind",
      "the configuration version is older than this binary; run the command",
      {
        fields: [
          ["config_version", version],
          ["supported_version", CONFIG_VERSION],
          ["command", "kanthord upgrade"],
        ],
      },
    );
  const issues: string[] = [];
  inspect(schema, value, "", issues);
  if (issues.length)
    throw new Diagnostic(
      "system.config.invalid_field",
      "invalid configuration fields",
      { details: issues },
    );
  const config = convict<ServerConfig>(schema, { args: [], env: {} });
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
    Buffer.from(properties.master_key, "base64").length,
    MASTER_KEY_BYTES,
  );
  return config;
}

export function readConfig(path: string): string {
  if (!audit(path, "file", true))
    throw new Diagnostic("system.config.not_found", "configuration is absent", {
      fields: [
        ["config", path],
        ["command", `kanthord config init --config ${JSON.stringify(path)}`],
        ["container", CONTAINER_INIT_COMMAND],
      ],
    });
  audit(dirname(path), "directory");
  return readPrivate(path);
}

export function loadConfig(path: string): ServerConfig {
  return configuration(parseMapping(readConfig(path))).getProperties();
}

export function initialConfig(
  allowedHosts: readonly string[] = [],
  bind: string = gatewayConfigSchema.bind.default,
  basePath: string = gatewayConfigSchema.base_path.default,
): string {
  return stringify(
    configuration({
      [CONFIG_VERSION_FIELD]: CONFIG_VERSION,
      master_key: randomBytes(MASTER_KEY_BYTES).toString("base64"),
      gateway: {
        bind,
        base_path: basePath,
        allowed_hosts: [
          ...new Set([
            ...gatewayConfigSchema.allowed_hosts.default,
            ...allowedHosts,
          ]),
        ],
      },
    }).getProperties(),
  );
}

export function showConfig(path: string): string {
  return stringify(JSON.parse(configuration(loadConfig(path)).toString()));
}
