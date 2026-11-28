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
import { loadPi } from "../../agent/pi.ts";
import { METADATA_ENV } from "../../llm/model-connector.ts";
import { isLlmPlatform, LLM_PLATFORMS, Platform } from "../../llm/platforms.ts";

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
const BYTE_ORDER_MARK = "\uFEFF";

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

interface MetadataName {
  envName: string;
  metaField: string;
  json?: boolean;
}

interface MappedMetadata {
  metadata: Record<string, unknown>;
  failedNames: Set<string>;
}

interface RoutingMetadataInput {
  env: Record<string, string>;
  provider: Platform;
  authPath: string;
}

const OPENAI_COMPATIBLE_NAMES: readonly MetadataName[] = [
  { envName: "OPENAI_COMPATIBLE_BASE_URL", metaField: "base_url" },
  { envName: "OPENAI_COMPATIBLE_MODELS", metaField: "models", json: true },
];

function metadataNamesOf(provider: Platform): readonly MetadataName[] {
  if (provider === Platform.OpenAICompatible) return OPENAI_COMPATIBLE_NAMES;
  return Object.entries(METADATA_ENV[provider] ?? {}).map(
    ([metaField, envName]) => ({ envName, metaField }),
  );
}

function envFieldName(name: string): string {
  return `${ENV_FIELD}.${name}`;
}

function mapMetadata(
  names: readonly MetadataName[],
  env: Record<string, string>,
): MappedMetadata {
  const metadata: Record<string, unknown> = {};
  const failedNames = new Set<string>();
  for (const { envName, metaField, json } of names) {
    if (!Object.hasOwn(env, envName)) {
      failedNames.add(envName);
      continue;
    }
    const text = env[envName]!;
    if (!json) {
      metadata[metaField] = text;
      continue;
    }
    try {
      metadata[metaField] = JSON.parse(text);
    } catch {
      failedNames.add(envName);
    }
  }
  return { metadata, failedNames };
}

function refuseEnv(authPath: string, field: string): never {
  throw new Diagnostic(
    AUTH_ENTRY_INVALID,
    "run agent: the entry env does not pass the metadata schema of the provider.",
    {
      fields: [
        ["path", authPath],
        ["field", field],
      ],
    },
  );
}

function firstExtraName(
  names: readonly MetadataName[],
  env: Record<string, string>,
): string | undefined {
  return Object.keys(env)
    .sort()
    .find((name) => !names.some(({ envName }) => envName === name));
}

function checkRoutingMetadata(
  input: RoutingMetadataInput,
): Record<string, unknown> | null {
  const { env, provider, authPath } = input;
  const schema = LLM_PLATFORMS[provider].metadata_schema;
  const names = metadataNamesOf(provider);
  const { metadata, failedNames } = mapMetadata(names, env);
  const result = schema?.safeParse(metadata);
  const failedFields = (result?.error?.issues ?? []).map(
    (issue) => issue.path[0],
  );
  const failed = names.find(
    ({ envName, metaField }) =>
      failedNames.has(envName) || failedFields.includes(metaField),
  );
  if (failed) refuseEnv(authPath, envFieldName(failed.envName));
  const extra = firstExtraName(names, env);
  if (extra !== undefined) refuseEnv(authPath, envFieldName(extra));
  if (result === undefined) return null;
  if (!result.success) refuseEnv(authPath, ENV_FIELD);
  return result.data;
}

function agentProvider(rawProvider: string, entryType: string): string {
  if (rawProvider === ANTHROPIC_PROVIDER && entryType === SecretShape.OAuth)
    return ANTHROPIC_SUBSCRIPTION_PLATFORM;
  return rawProvider;
}

function envOf(entry: RawAuthEntry): Record<string, string> {
  if (entry.type !== SecretShape.ApiKey) return {};
  return entry.env ?? {};
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
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

function validateFileEntry(
  providerId: string,
  entry: unknown,
  absolute: string,
): void {
  const entryFields = (field: string): [string, string][] => [
    ["path", absolute],
    ["field", field ? `${providerId}.${field}` : providerId],
  ];
  if (
    entry === null ||
    typeof entry !== TYPEOF_OBJECT ||
    Array.isArray(entry)
  ) {
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: an auth entry is not an object.",
      { fields: entryFields("") },
    );
  }
  const typeValue = (entry as Record<string, unknown>)["type"];
  if (typeValue === SecretShape.ApiKey) {
    parseApiKeyEntry(entry, entryFields);
  } else if (typeValue === SecretShape.OAuth) {
    parseOAuthEntry(entry, entryFields);
  } else {
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: an auth entry type is unknown.",
      { fields: entryFields("type") },
    );
  }
}

function withoutByteOrderMark(text: string): string {
  return text.startsWith(BYTE_ORDER_MARK)
    ? text.slice(BYTE_ORDER_MARK.length)
    : text;
}

export function checkAuthFileContents(authPath: string): void {
  const absolute = resolve(authPath);
  const pathFields = [["path", absolute]] as [string, string][];

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutByteOrderMark(readFileSync(absolute, "utf-8")));
  } catch {
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the --auth file is unreadable or is not valid JSON.",
      { fields: pathFields },
    );
  }

  if (
    parsed === null ||
    typeof parsed !== TYPEOF_OBJECT ||
    Array.isArray(parsed)
  ) {
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the --auth file root is not a plain object.",
      { fields: pathFields },
    );
  }

  for (const [providerId, entry] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    validateFileEntry(providerId, entry, absolute);
  }
}

export async function readAuthEntry(
  piProviderIdValue: string,
  authPath: string,
): Promise<unknown> {
  const absolute = resolve(authPath);
  const fields = [
    ["path", absolute],
    ["field", piProviderIdValue],
  ] as [string, string][];
  const { readStoredCredential } = await loadPi();
  const raw: unknown = readStoredCredential(piProviderIdValue, absolute);
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

  const provider = agentProvider(rawProvider, entry.type);
  if (
    !isLlmPlatform(provider) ||
    entry.type !== LLM_PLATFORMS[provider].secret_shape
  )
    throw new Diagnostic(
      AUTH_ENTRY_INVALID,
      "run agent: the entry type does not match the provider credential shape.",
      {
        fields: fields("type"),
      },
    );

  const metadata = checkRoutingMetadata({
    env: envOf(entry),
    provider,
    authPath: absolute,
  });

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
      "run agent: the OAuth credential expires within the refresh window of the wall deadline.",
      {
        fields: [["path", absolute]],
      },
    );
}

export function piProviderIdOf(provider: string): string {
  return piProviderId(provider as Parameters<typeof piProviderId>[0]);
}

const AUTH_CONFIG_SUBPATH = join(".config", "kanthord", "auth.json");

export function userHome(): string | null {
  try {
    return userInfo().homedir;
  } catch {
    return null;
  }
}

export function defaultAuthPath(): string {
  const home = userHome();
  if (home === null)
    throw new Diagnostic(
      AUTH_FILE_INVALID,
      "run agent: the user database gives no home directory.",
      {},
    );
  return join(home, AUTH_CONFIG_SUBPATH);
}
