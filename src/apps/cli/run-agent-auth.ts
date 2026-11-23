import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { z } from "zod";
import type { Credential } from "@earendil-works/pi-ai";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  ANTHROPIC_SUBSCRIPTION_PLATFORM,
  piProviderId,
} from "../../kernel/pi-provider.ts";
import {
  isNonblank,
  piCredentialSchema,
  SecretShape,
} from "../../custody/contract.ts";
import { OPENAI_COMPATIBLE_PROVIDER } from "../../agent/contract.ts";

const AUTH_FILE_INVALID = "cli.run.agent.auth_file_invalid";
const AUTH_FILE_OWNER = "cli.run.agent.auth_file_owner";
const AUTH_FILE_MODE = "cli.run.agent.auth_file_mode";
const AUTH_PLACE = "cli.run.agent.auth_place";
const AUTH_ENTRY_MISSING = "cli.run.agent.auth_entry_missing";
const AUTH_ENTRY_INVALID = "cli.run.agent.auth_entry_invalid";
const AUTH_KEY_COMMAND = "cli.run.agent.auth_key_command";
const AUTH_KEY_REFERENCE = "cli.run.agent.auth_key_reference";
const CREDENTIAL_EXPIRING = "cli.run.agent.credential_expiring";

const GROUP_OTHER_MODE = 0o077;
const PI_OAUTH_REFRESH_WINDOW_MS = 300000;

const ANTHROPIC_PROVIDER = "anthropic";
const TYPEOF_OBJECT = "object";
const TYPEOF_STRING = "string";

const BASE_URL_PATTERN = /^https?:\/\/[^?#]+[^?#/]$/;
const nonblankString = z.string().min(1).refine(isNonblank);

const rawApiKeyEntrySchema = z.strictObject({
  type: z.literal(SecretShape.ApiKey),
  key: z.string().min(1).refine(isNonblank),
  env: z.record(z.string(), z.string()).optional(),
});

const rawOauthEntrySchema = z.object({
  type: z.literal(SecretShape.OAuth),
  refresh: z.string().min(1),
  access: z.string().min(1),
  expires: z.number().int(),
});

type RawApiKeyEntry = z.infer<typeof rawApiKeyEntrySchema>;
type RawOauthEntry = z.infer<typeof rawOauthEntrySchema>;
type RawAuthEntry = RawApiKeyEntry | RawOauthEntry;

export type CheckedAuthEntry = {
  credential: Credential;
  metadata: Record<string, unknown> | null;
  credentialValues: string[];
};

const ENV_FIELD = "env";

type FieldValidator = (envName: string, value: string) => boolean;

interface ProviderMetadataRule {
  envName: string;
  metaField: string;
  validate: FieldValidator;
  transform?: (value: string) => unknown;
}

function envFieldName(name: string): string {
  return `${ENV_FIELD}.${name}`;
}

function nonblankValidator(_: string, value: string): boolean {
  return nonblankString.safeParse(value).success;
}

function urlValidator(_: string, value: string): boolean {
  return BASE_URL_PATTERN.test(value);
}

function jsonArrayValidator(_: string, value: string): boolean {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return false;
    for (const item of parsed) {
      if (!item || typeof item !== TYPEOF_OBJECT) return false;
      const id = (item as Record<string, unknown>)["id"];
      if (typeof id !== TYPEOF_STRING || !(id as string).trim()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const OPENAI_COMPATIBLE_RULES: ProviderMetadataRule[] = [
  {
    envName: "OPENAI_COMPATIBLE_BASE_URL",
    metaField: "base_url",
    validate: urlValidator,
  },
  {
    envName: "OPENAI_COMPATIBLE_MODELS",
    metaField: "models",
    validate: jsonArrayValidator,
    transform: (v) => JSON.parse(v),
  },
];

const AMAZON_BEDROCK_PROVIDER = "amazon-bedrock";
const GOOGLE_VERTEX_PROVIDER = "google-vertex";
const AZURE_PROVIDER = "azure";
const CLOUDFLARE_WORKERS_AI_PROVIDER = "cloudflare-workers-ai";
const CLOUDFLARE_AI_GATEWAY_PROVIDER = "cloudflare-ai-gateway";

const PROVIDER_RULES: Readonly<
  Record<string, ProviderMetadataRule[] | undefined>
> = {
  [OPENAI_COMPATIBLE_PROVIDER]: OPENAI_COMPATIBLE_RULES,
  [AMAZON_BEDROCK_PROVIDER]: [
    { envName: "AWS_REGION", metaField: "region", validate: nonblankValidator },
  ],
  [GOOGLE_VERTEX_PROVIDER]: [
    {
      envName: "GOOGLE_CLOUD_PROJECT",
      metaField: "project",
      validate: nonblankValidator,
    },
    {
      envName: "GOOGLE_CLOUD_LOCATION",
      metaField: "location",
      validate: nonblankValidator,
    },
  ],
  [AZURE_PROVIDER]: [
    {
      envName: "AZURE_OPENAI_RESOURCE_NAME",
      metaField: "resource_name",
      validate: nonblankValidator,
    },
  ],
  [CLOUDFLARE_WORKERS_AI_PROVIDER]: [
    {
      envName: "CLOUDFLARE_ACCOUNT_ID",
      metaField: "account_id",
      validate: nonblankValidator,
    },
  ],
  [CLOUDFLARE_AI_GATEWAY_PROVIDER]: [
    {
      envName: "CLOUDFLARE_ACCOUNT_ID",
      metaField: "account_id",
      validate: nonblankValidator,
    },
    {
      envName: "CLOUDFLARE_GATEWAY_ID",
      metaField: "gateway_id",
      validate: nonblankValidator,
    },
  ],
};

function providerRulesOf(provider: string): ProviderMetadataRule[] | null {
  return PROVIDER_RULES[provider] ?? null;
}

function checkNoExtraEnvNames(
  envObj: Record<string, string>,
  requiredNames: string[],
  makeFields: (f: string) => [string, string][],
): void {
  for (const name of Object.keys(envObj).sort()) {
    if (!requiredNames.includes(name))
      throw new Diagnostic(
        AUTH_ENTRY_INVALID,
        "run agent: the entry env holds a name outside the provider list.",
        {
          fields: makeFields(envFieldName(name)),
        },
      );
  }
}

function checkRoutingMetadata(
  env: Record<string, string> | undefined,
  provider: string,
  authPath: string,
): Record<string, unknown> | null {
  const makeFields = (field: string) =>
    [
      ["path", authPath],
      ["field", field],
    ] as [string, string][];
  const rules = providerRulesOf(provider);

  if (rules === null) {
    if (env !== undefined && Object.keys(env).length)
      throw new Diagnostic(
        AUTH_ENTRY_INVALID,
        "run agent: the entry env has no names for this provider.",
        {
          fields: makeFields(`${ENV_FIELD}.${Object.keys(env).sort()[0]!}`),
        },
      );
    return null;
  }

  const envObj = env ?? {};
  const requiredNames = rules.map((r) => r.envName);
  const meta: Record<string, unknown> = {};

  for (const rule of rules) {
    const { envName, metaField, validate, transform } = rule;
    if (!(envName in envObj))
      throw new Diagnostic(
        AUTH_ENTRY_INVALID,
        "run agent: the entry env is missing a required name.",
        {
          fields: makeFields(envFieldName(envName)),
        },
      );
    const value = envObj[envName]!;
    if (!validate(envName, value))
      throw new Diagnostic(
        AUTH_ENTRY_INVALID,
        "run agent: the entry env value is invalid.",
        {
          fields: makeFields(envFieldName(envName)),
        },
      );
    meta[metaField] = transform ? transform(value) : value;
  }

  checkNoExtraEnvNames(envObj, requiredNames, makeFields);

  return meta;
}

function agentProvider(rawProvider: string, entryType: string): string {
  if (rawProvider === ANTHROPIC_PROVIDER && entryType === SecretShape.OAuth)
    return ANTHROPIC_SUBSCRIPTION_PLATFORM;
  return rawProvider;
}

const OAUTH_PROVIDERS: readonly string[] = [
  ANTHROPIC_SUBSCRIPTION_PLATFORM,
  "github-copilot",
  "openai-codex",
];

function secretShapeOf(provider: string): string {
  if (OAUTH_PROVIDERS.includes(provider)) return SecretShape.OAuth;
  return SecretShape.ApiKey;
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const BOM_CODE = 0xfeff;

function readRawEntry(providerId: string, authPath: string): unknown {
  try {
    const text = readFileSync(authPath, "utf-8");
    const stripped = text.charCodeAt(0) === BOM_CODE ? text.slice(1) : text;
    const data = JSON.parse(stripped) as Record<string, unknown>;
    return data[providerId];
  } catch {
    return undefined;
  }
}

export function credentialValues(credential: Credential): string[] {
  if (credential.type === SecretShape.OAuth)
    return [credential.access, credential.refresh];
  return credential.key === undefined ? [] : [credential.key];
}

export function checkAuthFile(
  authPath: string,
  workspaceRealPath: string,
): void {
  const absolute = resolve(authPath);
  const fields = [["path", absolute]] as [string, string][];

  const stat = lstatSync(absolute, { throwIfNoEntry: false });
  if (stat === undefined)
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the --auth file is absent.",
      { fields },
    );
  if (stat.isSymbolicLink())
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the --auth file is a symbolic link.",
      { fields },
    );
  if (!stat.isFile())
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the --auth path is not a regular file.",
      { fields },
    );

  const uid = userInfo().uid;
  if (stat.uid !== uid)
    throw new Diagnostic(
      AUTH_FILE_OWNER,
      "run agent: another user owns the --auth file.",
      { fields },
    );

  if (stat.mode & GROUP_OTHER_MODE)
    throw new Diagnostic(
      AUTH_FILE_MODE,
      "run agent: the --auth file has a group or other permission bit.",
      { fields },
    );

  const realAuth = join(realPathOrSelf(dirname(absolute)), basename(absolute));
  const realWorkspace = realPathOrSelf(workspaceRealPath);
  if (realAuth.startsWith(realWorkspace + "/") || realAuth === realWorkspace)
    throw new Diagnostic(
      AUTH_PLACE,
      "run agent: the --auth file is inside the workspace.",
      { fields },
    );
}

function parseApiKeyEntry(
  raw: unknown,
  fields: (f: string) => [string, string][],
): RawApiKeyEntry {
  const result = rawApiKeyEntrySchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path =
      issue?.path[0] === ENV_FIELD
        ? ENV_FIELD
        : (issue?.path.join(".") ?? "key");
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the api_key entry failed schema validation.",
      {
        fields: fields(path || "key"),
      },
    );
  }
  return result.data;
}

function parseOAuthEntry(
  raw: unknown,
  fields: (f: string) => [string, string][],
): RawOauthEntry {
  const result = rawOauthEntrySchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") ?? "type";
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the oauth entry failed schema validation.",
      {
        fields: fields(path || "type"),
      },
    );
  }
  return {
    type: SecretShape.OAuth,
    access: result.data.access,
    refresh: result.data.refresh,
    expires: result.data.expires,
  };
}

function parseRawEntry(raw: unknown, authPath: string): RawAuthEntry {
  const fields = (field: string) =>
    [
      ["path", authPath],
      ["field", field],
    ] as [string, string][];
  if (raw === null || typeof raw !== TYPEOF_OBJECT) {
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the auth entry is not an object.",
      {
        fields: fields("type"),
      },
    );
  }

  const typeValue = (raw as Record<string, unknown>)["type"];
  if (typeValue === SecretShape.ApiKey) return parseApiKeyEntry(raw, fields);
  if (typeValue === SecretShape.OAuth) return parseOAuthEntry(raw, fields);

  throw new Diagnostic(
    AUTH_ENTRY_INVALID,
    "run agent: the auth entry type is unknown.",
    {
      fields: fields("type"),
    },
  );
}

export function readAuthEntry(
  piProviderIdValue: string,
  authPath: string,
): unknown {
  const absolute = resolve(authPath);
  const fields = [
    ["path", absolute],
    ["field", piProviderIdValue],
  ] as [string, string][];
  const raw = readRawEntry(piProviderIdValue, absolute);
  if (raw === undefined)
    throw new Diagnostic(
      AUTH_ENTRY_MISSING,
      "run agent: the --auth file has no entry for the selected provider.",
      { fields },
    );
  return raw;
}

export function checkAuthEntry(
  raw: unknown,
  rawProvider: string,
  authPath: string,
): CheckedAuthEntry {
  const absolute = resolve(authPath);
  const fields = (field: string) =>
    [
      ["path", absolute],
      ["field", field],
    ] as [string, string][];

  const entry = parseRawEntry(raw, absolute);

  if (entry.type === SecretShape.ApiKey) {
    if (entry.key.startsWith("!"))
      throw new Diagnostic(
        AUTH_KEY_COMMAND,
        "run agent: the api_key starts with !",
        {
          fields: fields("key"),
        },
      );
    if (entry.key.includes("$"))
      throw new Diagnostic(
        AUTH_KEY_REFERENCE,
        "run agent: the api_key contains $",
        {
          fields: fields("key"),
        },
      );
  }

  const agentProv = agentProvider(rawProvider, entry.type);
  const expectedShape = secretShapeOf(agentProv);
  if (entry.type !== expectedShape)
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the entry type does not match the provider credential shape.",
      {
        fields: fields("type"),
      },
    );

  const envObj = entry.type === SecretShape.ApiKey ? entry.env : undefined;
  const metadata = checkRoutingMetadata(envObj, rawProvider, absolute);

  const parsed = piCredentialSchema.safeParse(
    entry.type === SecretShape.ApiKey
      ? { type: entry.type, key: entry.key }
      : {
          type: entry.type,
          access: entry.access,
          refresh: entry.refresh,
          expires: entry.expires,
        },
  );
  if (!parsed.success)
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the entry failed the credential schema.",
      {
        fields: fields(entry.type === SecretShape.ApiKey ? "key" : "type"),
      },
    );
  const credential = parsed.data;

  return {
    credential,
    metadata,
    credentialValues: credentialValues(credential),
  };
}

export function checkAuthExpiry(
  credential: Credential,
  wallDeadlineMs: number,
  authPath: string,
): void {
  if (credential.type !== SecretShape.OAuth) return;
  const absolute = resolve(authPath);
  if (credential.expires < wallDeadlineMs + PI_OAUTH_REFRESH_WINDOW_MS)
    throw new Diagnostic(
      CREDENTIAL_EXPIRING,
      "run agent: the OAuth credential expires before the wall deadline.",
      {
        fields: [["path", absolute]],
      },
    );
}

export function piProviderIdOf(provider: string): string {
  return piProviderId(provider as Parameters<typeof piProviderId>[0]);
}

const AUTH_CONFIG_SUBPATH = join(".config", "kanthord", "auth.json");

export function defaultAuthPath(): string {
  try {
    return join(userInfo().homedir, AUTH_CONFIG_SUBPATH);
  } catch {
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the user database gives no home directory.",
      {},
    );
  }
}
