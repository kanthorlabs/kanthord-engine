import assert from "node:assert/strict";
import { sign, verify } from "hono/jwt";
import { ulid } from "ulid";
import type { Store, Transaction } from "../store.ts";
import { Diagnostic } from "../shared/errors.ts";
import { deriveKey } from "../shared/json.ts";
import { createIdentity, identitySchema } from "../shared/identity.ts";
import type { MachineDependencies, VerifiedClient } from "./contracts.ts";
import { unauthorized } from "./errors.ts";
import {
  CLIENT_IDENTITY_PREFIX,
  IdentityKind,
  KANTHORD_AUTH_USERNAME,
  MAX_BINDING_ID_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
} from "./constants.ts";
import { isObject, isString } from "../shared/values.ts";
import { background, type Context } from "../context.ts";

const MILLISECONDS_PER_SECOND = 1000;
const BEARER_PREFIX_LENGTH = 7;
const MIN_TOKEN_LIFETIME = 0;
const clientIdentitySchema = identitySchema(CLIENT_IDENTITY_PREFIX);

export interface HumanIdentity {
  readonly kind: typeof IdentityKind.Human;
  readonly accountId: string;
  readonly name: string;
  readonly jti: string;
}
export interface MachineIdentity {
  readonly kind: typeof IdentityKind.Client;
  readonly clientId: string;
  readonly name: string;
  readonly workerBindingId: string;
  readonly projectId: string;
  readonly runtimeIdentity?: string;
  readonly jti: string;
}
export type CallerIdentity = HumanIdentity | MachineIdentity;
const humans = new WeakSet<object>();
const machines = new WeakSet<object>();

function human(accountId: string, name: string, jti: string): HumanIdentity {
  assert.equal(parseHumanUsername(accountId), accountId);
  assert.equal(parseDisplayName(name), name);
  const value = Object.freeze({
    kind: IdentityKind.Human,
    accountId,
    name,
    jti,
  });
  humans.add(value);
  return value;
}

function machine(
  client: VerifiedClient,
  jti: string,
  runtimeIdentity?: string,
): MachineIdentity {
  assert.ok(clientIdentitySchema.safeParse(client.clientId).success);
  assert.equal(parseDisplayName(client.name), client.name);
  const value = Object.freeze({
    kind: IdentityKind.Client,
    clientId: client.clientId,
    name: client.name,
    workerBindingId: client.workerBindingId,
    projectId: client.projectId,
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    jti,
  });
  machines.add(value);
  return value;
}

export function isHumanIdentity(value: unknown): value is HumanIdentity {
  return isObject(value) && humans.has(value);
}
export function isMachineIdentity(value: unknown): value is MachineIdentity {
  return isObject(value) && machines.has(value);
}

export interface TokenResponse {
  token: string;
  expiresAt: number;
}

function validText(value: unknown, maximum: number): value is string {
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

export function parseWorkerBinding(value: unknown): string {
  if (!validText(value, MAX_BINDING_ID_LENGTH))
    throw new Diagnostic(
      "gateway.authentication.invalid_binding",
      "binding: expected a nonblank string of 1–128 characters.",
    );
  return value;
}

function signingKey(masterKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(deriveKey(masterKey, "gateway/jwt-hs256/v1")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function generateJWT(
  masterKey: string,
  lifetime: number,
  claims: { sub: string; name: string; kind: string; binding?: string },
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
  return {
    token: await sign(
      { ...claims, iat, exp, jti: ulid() },
      await signingKey(masterKey),
      "HS256",
    ),
    expiresAt: exp * MILLISECONDS_PER_SECOND,
  };
}

export async function generateHumanJWT(
  masterKey: string,
  lifetime: number,
  username: string = KANTHORD_AUTH_USERNAME,
  name: string = username,
): Promise<TokenResponse> {
  return generateJWT(masterKey, lifetime, {
    sub: parseHumanUsername(username),
    name: parseDisplayName(name),
    kind: IdentityKind.Human,
  });
}

export async function generateMachineJWT(
  masterKey: string,
  lifetime: number,
  binding: string,
  name?: string,
): Promise<TokenResponse> {
  const sub = createIdentity(CLIENT_IDENTITY_PREFIX);
  return generateJWT(masterKey, lifetime, {
    sub,
    name: parseDisplayName(name ?? sub),
    kind: IdentityKind.Client,
    binding: parseWorkerBinding(binding),
  });
}

export function requireTokenTerminal(
  output: Pick<NodeJS.WriteStream, "isTTY">,
): void {
  if (!output.isTTY)
    throw new Diagnostic(
      "cli.output.terminal_required",
      "JWT output: standard output must be a terminal to display a token.",
    );
}

export class Authentication {
  private readonly store: Store;
  private readonly key: Promise<CryptoKey>;
  private readonly machines?: MachineDependencies;
  private readonly denylist = new Map<string, number>();

  constructor(
    store: Store,
    masterKey: string,
    dependencies?: MachineDependencies,
  ) {
    this.store = store;
    this.key = signingKey(masterKey);
    this.machines = dependencies;
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.key;
      this.store.database
        .prepare("SELECT jti FROM gateway_token_denylist LIMIT 1")
        .get();
      return true;
    } catch {
      return false;
    }
  }

  sweep(): void {
    this.store.transaction(({ database }) => {
      database
        .prepare("DELETE FROM gateway_token_denylist WHERE expires_at <= ?")
        .run(Date.now());
    });
    this.denylist.clear();
    for (const row of this.store.database
      .prepare("SELECT jti, expires_at FROM gateway_token_denylist")
      .all())
      this.denylist.set(String(row.jti), Number(row.expires_at));
  }

  ban(jti: string, expiresAt: number): void {
    const previous = this.denylist.get(jti);
    try {
      this.store.transaction(({ database }) => {
        database
          .prepare(
            "INSERT OR REPLACE INTO gateway_token_denylist VALUES (?, ?, ?)",
          )
          .run(jti, expiresAt, Date.now());
        this.denylist.set(jti, expiresAt);
      });
    } catch (error) {
      if (previous === undefined) this.denylist.delete(jti);
      else this.denylist.set(jti, previous);
      throw error;
    }
  }

  register(
    transaction: Transaction,
    identity: MachineIdentity,
  ): MachineIdentity {
    if (!isMachineIdentity(identity) || !this.machines) throw unauthorized();
    const registration = this.machines.worker.register(transaction, identity);
    assert.equal(registration.clientId, identity.clientId);
    assert.equal(registration.name, identity.name);
    assert.equal(registration.projectId, identity.projectId);
    assert.equal(registration.workerBindingId, identity.workerBindingId);
    return machine(registration, identity.jti, registration.runtimeIdentity);
  }

  private async resolveMachine(
    clientId: string,
    name: string,
    binding: string,
    jti: string,
    context: Context,
  ): Promise<MachineIdentity> {
    const resolved = await this.machines?.project.resolveWorkerBinding(
      binding,
      context,
    );
    if (!resolved || resolved.workerBindingId !== binding) throw unauthorized();
    const registration = this.machines!.worker.findByClient(clientId);
    if (
      registration &&
      (registration.clientId !== clientId ||
        registration.workerBindingId !== resolved.workerBindingId ||
        registration.projectId !== resolved.projectId)
    )
      throw unauthorized();
    return machine(
      { clientId, name, ...resolved },
      jti,
      registration?.runtimeIdentity,
    );
  }

  async recheck(
    identity: CallerIdentity,
    context: Context,
  ): Promise<CallerIdentity> {
    if (!isHumanIdentity(identity) && !isMachineIdentity(identity))
      throw unauthorized();
    if (this.denylist.has(identity.jti)) throw unauthorized();
    if (isHumanIdentity(identity))
      return human(identity.accountId, identity.name, identity.jti);
    const current = await this.resolveMachine(
      identity.clientId,
      identity.name,
      identity.workerBindingId,
      identity.jti,
      context,
    );
    if (current.runtimeIdentity !== identity.runtimeIdentity)
      throw unauthorized();
    return current;
  }

  async authenticate(
    authorization: string | undefined,
    context: Context = background,
  ): Promise<CallerIdentity> {
    if (!authorization || !/^Bearer [^\s,]+$/i.test(authorization))
      throw unauthorized();
    const key = await this.key;
    let claims;
    try {
      claims = await verify(authorization.slice(BEARER_PREFIX_LENGTH), key, {
        alg: "HS256",
        exp: false,
        iat: false,
        nbf: false,
      });
    } catch {
      throw unauthorized();
    }
    if (
      !isString(claims.jti) ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp! <= Math.floor(Date.now() / MILLISECONDS_PER_SECOND) ||
      !validText(claims.name, MAX_DISPLAY_NAME_LENGTH) ||
      this.denylist.has(claims.jti)
    )
      throw unauthorized();
    if (claims.kind === IdentityKind.Human) {
      if (
        !validText(claims.sub, MAX_HUMAN_USERNAME_LENGTH) ||
        "binding" in claims ||
        "reg" in claims
      )
        throw unauthorized();
      return human(claims.sub, claims.name, claims.jti);
    }
    if (
      claims.kind !== IdentityKind.Client ||
      !isString(claims.sub) ||
      !clientIdentitySchema.safeParse(claims.sub).success ||
      !validText(claims.binding, MAX_BINDING_ID_LENGTH)
    )
      throw unauthorized();
    return this.resolveMachine(
      claims.sub!,
      claims.name,
      claims.binding,
      claims.jti,
      context,
    );
  }
}
