import assert from "node:assert/strict";
import { ulid } from "ulid";
import { Diagnostic } from "../../kernel/errors.ts";
import { deriveKey } from "../../kernel/json.ts";
import { createIdentity, identitySchema } from "../../kernel/identity.ts";
import {
  bindingNameSchema,
  workerResourceIdentity,
} from "../../project/contract.ts";
import { isString } from "../../kernel/values.ts";
import {
  CLIENT_IDENTITY_PREFIX,
  CONNECTION_PREFIX,
  IdentityKind,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
  WORKER_INSTANCE_PREFIX,
} from "../../kernel/caller.ts";
export const KANTHORD_AUTH_USERNAME = "kanthorlabs";
const MILLISECONDS_PER_SECOND = 1000;
const MIN_TOKEN_LIFETIME = 0;
const CLIENT_SECRET_LABEL_PREFIX = "worker/client-secret/v";
const SIGNING_KEY_LABEL_PREFIX = "gateway/jwt-hs256/v";
const NO_AUTH_VERSION = 0;
export const SLOT_TOKEN_LIFETIME = 60;
export const WORKER_TOKEN_LIFETIME = 3600;
export interface TokenResponse {
  token: string;
  expiresAt: number;
}

export function validText(value: unknown, maximum: number): value is string {
  return isString(value) && !!value.trim() && value.length <= maximum;
}

export function parseHumanUsername(value: unknown): string {
  if (!validText(value, MAX_HUMAN_USERNAME_LENGTH))
    throw new Diagnostic(
      "gateway.authentication.invalid_username",
      "username: expected a nonblank string of 1–64 characters.",
    );
  return value;
}

export function parseDisplayName(value: unknown): string {
  if (!validText(value, MAX_DISPLAY_NAME_LENGTH))
    throw new Diagnostic(
      "gateway.authentication.invalid_name",
      "name: expected a nonblank string of 1–64 characters.",
    );
  return value;
}

export function parseBindingName(value: unknown): string {
  const parsed = bindingNameSchema.safeParse(value);
  if (!parsed.success)
    throw new Diagnostic(
      "gateway.authentication.invalid_binding",
      "binding: expected 1–63 lower-case letters, digits or hyphens, beginning with a letter.",
    );
  return parsed.data;
}

export function parseProjectId(value: unknown): string {
  const parsed = identitySchema("project").safeParse(value);
  if (!parsed.success)
    throw new Diagnostic(
      "gateway.authentication.invalid_project",
      "project: expected a canonical project identity.",
    );
  return parsed.data;
}

function requireAuthVersion(authVersion: number): number {
  assert.ok(Number.isSafeInteger(authVersion) && authVersion > NO_AUTH_VERSION);
  return authVersion;
}

export function deriveClientSecret(
  masterKey: string,
  authVersion: number,
  sub: string,
): string {
  return deriveKey(
    masterKey,
    `${CLIENT_SECRET_LABEL_PREFIX}${requireAuthVersion(authVersion)}/${sub}`,
  ).toString("base64");
}

export function signingKey(
  masterKey: string,
  authVersion: number,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(
      deriveKey(
        masterKey,
        `${SIGNING_KEY_LABEL_PREFIX}${requireAuthVersion(authVersion)}`,
      ),
    ),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function generateJWT(
  masterKey: string,
  authVersion: number,
  lifetime: number,
  claims: {
    sub: string;
    name: string;
    kind: string;
    project_id?: string;
    resource_identity?: string;
    instance_id?: string;
    connection_id?: string;
  },
): Promise<TokenResponse> {
  if (!Number.isSafeInteger(lifetime) || lifetime < MIN_TOKEN_LIFETIME)
    throw new Diagnostic(
      "gateway.authentication.invalid_lifetime",
      "lifetime: expected a nonnegative safe integer of seconds.",
    );
  const iat = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  const exp = iat + lifetime;
  assert.ok(Number.isSafeInteger(exp));
  assert.ok(Number.isSafeInteger(exp * MILLISECONDS_PER_SECOND));
  const { sign } = await import("hono/jwt");
  return {
    token: await sign(
      { ...claims, iat, exp, jti: ulid() },
      await signingKey(masterKey, authVersion),
      "HS256",
    ),
    expiresAt: exp * MILLISECONDS_PER_SECOND,
  };
}

export async function generateHumanJWT(
  masterKey: string,
  authVersion: number,
  lifetime: number,
  username: string = KANTHORD_AUTH_USERNAME,
  name: string = username,
): Promise<TokenResponse> {
  return generateJWT(masterKey, authVersion, lifetime, {
    sub: parseHumanUsername(username),
    name: parseDisplayName(name),
    kind: IdentityKind.Human,
  });
}

export async function generateMachineJWT(
  masterKey: string,
  authVersion: number,
  lifetime: number,
  group: { projectId: string; bindingName: string },
  name?: string,
): Promise<TokenResponse> {
  const sub = createIdentity(CLIENT_IDENTITY_PREFIX);
  return generateJWT(masterKey, authVersion, lifetime, {
    sub,
    name: parseDisplayName(name ?? sub),
    kind: IdentityKind.Client,
    project_id: parseProjectId(group.projectId),
    resource_identity: workerResourceIdentity(
      parseBindingName(group.bindingName),
    ),
  });
}

export async function generateSlotJWT(
  masterKey: string,
  authVersion: number,
  slot: {
    clientId: string;
    projectId: string;
    bindingName: string;
    slot: number;
  },
): Promise<TokenResponse> {
  return generateJWT(masterKey, authVersion, SLOT_TOKEN_LIFETIME, {
    sub: identitySchema(CLIENT_IDENTITY_PREFIX).parse(slot.clientId),
    name: parseDisplayName(`server slot ${slot.slot}`),
    kind: IdentityKind.Client,
    project_id: parseProjectId(slot.projectId),
    resource_identity: workerResourceIdentity(
      parseBindingName(slot.bindingName),
    ),
  });
}

export async function generateWorkerJWT(
  masterKey: string,
  authVersion: number,
  instance: { instanceId: string; name: string },
): Promise<TokenResponse> {
  return generateJWT(masterKey, authVersion, WORKER_TOKEN_LIFETIME, {
    sub: identitySchema(WORKER_INSTANCE_PREFIX).parse(instance.instanceId),
    name: parseDisplayName(instance.name),
    kind: IdentityKind.Worker,
  });
}

export async function generateInstanceClientJWT(
  masterKey: string,
  authVersion: number,
  client: {
    clientId: string;
    projectId: string;
    resourceIdentity: string;
    instanceId: string;
    connectionId: string;
    name: string;
  },
): Promise<TokenResponse> {
  return generateJWT(masterKey, authVersion, WORKER_TOKEN_LIFETIME, {
    sub: identitySchema(CLIENT_IDENTITY_PREFIX).parse(client.clientId),
    name: parseDisplayName(client.name),
    kind: IdentityKind.Client,
    project_id: parseProjectId(client.projectId),
    resource_identity: client.resourceIdentity,
    instance_id: identitySchema(WORKER_INSTANCE_PREFIX).parse(
      client.instanceId,
    ),
    connection_id: identitySchema(CONNECTION_PREFIX).parse(client.connectionId),
  });
}

export function requireTokenTerminal(
  output: Pick<NodeJS.WriteStream, "isTTY">,
): void {
  if (!output.isTTY)
    throw new Diagnostic(
      "cli.output.terminal_required",
      "JWT output: standard output must be a terminal to display a token; pass --output <path>, or run the container command with -t.",
    );
}
