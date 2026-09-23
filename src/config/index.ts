import assert from "node:assert/strict";
import convict, { type Field, type Schema } from "convict";
import { parseDocument, stringify } from "yaml";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { audit, readPrivate } from "../shared/files.ts";
import { Diagnostic } from "../shared/errors.ts";
import { isObject, isString } from "../shared/values.ts";

export const LogDestination = {
  StandardError: "stderr",
  File: "file",
} as const;
export const MASTER_KEY_BYTES = 32;
const IPV4_VERSION = 4;
export const IPV6_LOOPBACK = "::1";
const EXHAUSTED_NODE_BUDGET = 0;
const EMPTY_SCHEMA_FIELD_COUNT = 0;

export interface ServerConfig {
  masterKey: string;
  log: {
    level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
    destination: (typeof LogDestination)[keyof typeof LogDestination];
  };
  gateway: {
    bind: string;
    port: number;
    allowedHosts: string[];
    allowedOrigins: string[];
    tokenLifetime: number;
  };
}

export function directories(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
) {
  const directory = (variable: string, fallback: string) =>
    join(
      env[variable] && isAbsolute(env[variable])
        ? env[variable]
        : join(home, fallback),
      "kanthord",
    );
  return {
    config: directory("XDG_CONFIG_HOME", ".config"),
    data: directory("XDG_DATA_HOME", ".local/share"),
    state: directory("XDG_STATE_HOME", ".local/state"),
    cache: directory("XDG_CACHE_HOME", ".cache"),
  };
}
export type Directories = ReturnType<typeof directories>;

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

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_NODES = 4096;
const MAX_CONFIG_DEPTH = 32;

/** Bound every traversal, including expansion of shared (non-cyclic) aliases. */
function inspectTree(
  value: unknown,
  budget: { remaining: number },
  ancestors: ReadonlySet<object>,
): void {
  assert.ok(
    budget.remaining >= EXHAUSTED_NODE_BUDGET &&
      budget.remaining <= MAX_CONFIG_NODES,
  );
  assert.ok(ancestors.size <= MAX_CONFIG_DEPTH);
  if (budget.remaining === EXHAUSTED_NODE_BUDGET)
    throw new Diagnostic(
      "system.config.too_many_values",
      "configuration: too many values.",
    );
  budget.remaining--;
  if (!isObject(value)) return;
  if (ancestors.has(value))
    throw new Diagnostic(
      "system.config.cyclic_alias",
      "configuration: cyclic aliases are not allowed.",
    );
  if (ancestors.size === MAX_CONFIG_DEPTH)
    throw new Diagnostic(
      "system.config.too_deep",
      "configuration: nesting is too deep.",
    );
  const prototype: unknown = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  )
    throw new Diagnostic(
      "system.config.invalid_mapping",
      "configuration: expected a plain mapping or array.",
    );
  const children: unknown[] = Object.values(value);
  if (children.length > budget.remaining)
    throw new Diagnostic(
      "system.config.too_many_values",
      "configuration: too many values.",
    );
  const parents = new Set(ancestors).add(value);
  for (const child of children) inspectTree(child, budget, parents);
}

export function parseMapping(source: string): Record<string, unknown> {
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIG_BYTES)
    throw new Diagnostic(
      "system.config.too_large",
      "configuration: YAML exceeds the 1 MiB limit.",
    );
  const document = parseDocument(source, {
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
  });
  assert.equal(document.options.stringKeys, true);
  assert.equal(document.options.uniqueKeys, true);
  if (document.errors.length || document.warnings.length)
    throw new Diagnostic(
      "system.config.invalid_yaml",
      "configuration: expected one valid YAML mapping with unique string keys.",
    );
  let value: unknown;
  // Alias-resolution errors can include source text; preserve only a safe failure.
  try {
    value = document.toJS({ maxAliasCount: 100 });
  } catch {
    throw new Diagnostic(
      "system.config.invalid_yaml",
      "configuration: invalid YAML mapping.",
    );
  }
  inspectTree(value, { remaining: MAX_CONFIG_NODES }, new Set());
  if (!isObject(value) || Array.isArray(value))
    throw new Diagnostic(
      "system.config.invalid_mapping",
      "configuration: expected one YAML mapping.",
    );
  return value as Record<string, unknown>;
}
convict.addParser({ extension: ["yaml", "yml"], parse: parseMapping });

const strings = (value: unknown) => {
  if (
    !Array.isArray(value) ||
    value.some((entry) => !isString(entry) || !entry.length)
  )
    throw new Error("expected an array of nonempty strings");
};
const schema = {
  masterKey: {
    doc: "32-byte master key, encoded as base64.",
    default: null,
    sensitive: true,
    format(value: unknown) {
      if (
        !isString(value) ||
        !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
        Buffer.from(value, "base64").length !== MASTER_KEY_BYTES ||
        Buffer.from(value, "base64").toString("base64") !== value
      )
        throw new Error("required 32-byte base64 secret");
    },
  },
  log: {
    level: {
      doc: "Operational log level.",
      format: ["trace", "debug", "info", "warn", "error", "fatal"],
      default: "info",
    },
    destination: {
      doc: "Operational log destination.",
      format: Object.values(LogDestination),
      default: LogDestination.StandardError,
    },
  },
  gateway: {
    bind: {
      doc: "Loopback listener address.",
      default: "127.0.0.1",
      format(value: unknown) {
        if (
          !isString(value) ||
          !(
            (isIP(value) === IPV4_VERSION && value.startsWith("127.")) ||
            value === IPV6_LOOPBACK
          )
        )
          throw new Error("expected a loopback IP address");
      },
    },
    port: { doc: "HTTP listener port.", format: "port", default: 31415 },
    allowedHosts: {
      doc: "Accepted Host headers, including port.",
      format: strings,
      default: ["127.0.0.1:31415", "localhost:31415"],
    },
    allowedOrigins: {
      doc: "Allowed CORS origins.",
      format: strings,
      default: [],
    },
    tokenLifetime: {
      doc: "Token lifetime in seconds.",
      format: "nat",
      default: 31536000,
    },
  },
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
