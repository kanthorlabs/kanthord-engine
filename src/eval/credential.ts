import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  createModels,
  type Credential,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SecretShape } from "../custody/contract.ts";
import { CodedError } from "../kernel/errors.ts";
import { PRIVATE_FILE_MODE } from "../kernel/files.ts";
import {
  ANTHROPIC_SUBSCRIPTION_PLATFORM,
  piProviderId,
} from "../kernel/pi-provider.ts";
import { PI_OAUTH_REFRESH_WINDOW_MS } from "../llm/refresh-watch.ts";
import type { NativeCredential } from "../apps/server/test-support.ts";

export const API_KEY_VARIABLE = "EVAL_ANTHROPIC_API_KEY";
export const AUTH_FILE_VARIABLE = "EVAL_ANTHROPIC_AUTH_FILE";

const CredentialErrorCode = {
  VariableRule: "eval.credential.variable_rule",
  AuthFileInvalid: "eval.credential.auth_file_invalid",
  RefreshFailed: "eval.credential.refresh_failed",
} as const;

const ANTHROPIC_PLATFORM = "anthropic";
const PROVIDER_ID = piProviderId(ANTHROPIC_SUBSCRIPTION_PLATFORM);
const JSON_INDENT = 2;

export const CredentialSourceKind = {
  Key: "key",
  AuthFile: "auth_file",
} as const;

export type CredentialSource =
  | { kind: typeof CredentialSourceKind.Key; key: string }
  | { kind: typeof CredentialSourceKind.AuthFile; path: string };

const oauthEntrySchema = z.looseObject({
  type: z.literal(SecretShape.OAuth),
  refresh: z.string().min(1),
  access: z.string().min(1),
  expires: z.number().int(),
});
const apiKeyEntrySchema = z.looseObject({
  type: z.literal(SecretShape.ApiKey),
});
const authFileSchema = z.record(z.string(), z.unknown());
const entrySchema = z.discriminatedUnion("type", [
  oauthEntrySchema,
  apiKeyEntrySchema,
]);

export function credentialSourceOf(env: NodeJS.ProcessEnv): CredentialSource {
  const key = env[API_KEY_VARIABLE];
  const path = env[AUTH_FILE_VARIABLE];
  if (Boolean(key) === Boolean(path))
    throw new CodedError(
      CredentialErrorCode.VariableRule,
      `Set exactly one of the variables ${API_KEY_VARIABLE} and ${AUTH_FILE_VARIABLE}.`,
    );
  if (key) return { kind: CredentialSourceKind.Key, key };
  if (!isAbsolute(path!))
    throw new CodedError(
      CredentialErrorCode.VariableRule,
      `The variable ${AUTH_FILE_VARIABLE} must hold an absolute path.`,
    );
  return { kind: CredentialSourceKind.AuthFile, path: path! };
}

function invalid(path: string, reason: string): CodedError {
  return new CodedError(
    CredentialErrorCode.AuthFileInvalid,
    `The auth file ${path} ${reason}.`,
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function readAuthFile(path: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw invalid(path, "cannot be read");
  }
  const parsed = authFileSchema.safeParse(parseJson(text));
  if (!parsed.success) throw invalid(path, "does not hold a JSON object");
  return parsed.data;
}

function writeAuthFile(path: string, entries: Record<string, unknown>): void {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(entries, null, JSON_INDENT)}\n`, {
    mode: PRIVATE_FILE_MODE,
  });
  renameSync(temporary, path);
}

function entryOf(
  entries: Record<string, unknown>,
  providerId: string,
  path: string,
): Credential | undefined {
  if (!Object.hasOwn(entries, providerId)) return undefined;
  const parsed = entrySchema.safeParse(entries[providerId]);
  if (!parsed.success)
    throw invalid(path, `holds an invalid ${providerId} entry`);
  return parsed.data;
}

function fileStore(path: string): CredentialStore {
  return {
    read: async (providerId) => entryOf(readAuthFile(path), providerId, path),
    list: async () => {
      const entries = readAuthFile(path);
      return Object.keys(entries).flatMap((providerId) => {
        const entry = entryOf(entries, providerId, path);
        return entry ? [{ providerId, type: entry.type }] : [];
      });
    },
    modify: async (providerId, fn) => {
      const entries = readAuthFile(path);
      const next = await fn(entryOf(entries, providerId, path));
      if (!next) return entryOf(entries, providerId, path);
      writeAuthFile(path, { ...entries, [providerId]: next });
      return next;
    },
    delete: async (providerId) => {
      const entries = Object.entries(readAuthFile(path));
      writeAuthFile(
        path,
        Object.fromEntries(entries.filter(([id]) => id !== providerId)),
      );
    },
  };
}

async function refresh(
  store: CredentialStore,
  path: string,
  validityMs: number,
): Promise<void> {
  const models = createModels({ credentials: store });
  models.setProvider(anthropicProvider());
  try {
    await models.getAuth(PROVIDER_ID, { minOAuthValidityMs: validityMs });
  } catch {
    throw new CodedError(
      CredentialErrorCode.RefreshFailed,
      `The token refresh for the auth file ${path} failed.`,
    );
  }
}

async function subscriptionCredential(
  path: string,
  leadMs: number,
): Promise<NativeCredential> {
  const store = fileStore(path);
  const validityMs = PI_OAUTH_REFRESH_WINDOW_MS + leadMs;
  let entry = await store.read(PROVIDER_ID);
  if (
    entry?.type === SecretShape.OAuth &&
    entry.expires <= Date.now() + validityMs
  ) {
    await refresh(store, path, validityMs);
    entry = await store.read(PROVIDER_ID);
  }
  if (entry?.type !== SecretShape.OAuth)
    throw invalid(path, `holds no ${PROVIDER_ID} OAuth entry`);
  const { refresh: refreshToken, access, expires } = entry;
  return {
    platform: ANTHROPIC_SUBSCRIPTION_PLATFORM,
    secret: { refresh: refreshToken, access, expires },
  };
}

export async function sandboxCredential(
  source: CredentialSource,
  leadMs: number,
): Promise<NativeCredential> {
  if (source.kind === CredentialSourceKind.Key)
    return { platform: ANTHROPIC_PLATFORM, secret: { key: source.key } };
  return subscriptionCredential(source.path, leadMs);
}
