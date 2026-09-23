import { verify } from "hono/jwt";
import type { Store } from "../kernel/store.ts";
import { identitySchema } from "../kernel/identity.ts";
import { isString } from "../kernel/values.ts";
import { background, type Context } from "../kernel/context.ts";
import {
  IdentityKind,
  CLIENT_IDENTITY_PREFIX,
  MAX_HUMAN_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_BINDING_ID_LENGTH,
  isHumanIdentity,
  isMachineIdentity,
  type MachineIdentity,
  type CallerIdentity,
} from "../kernel/caller.ts";
import {
  mintHumanIdentity,
  mintMachineIdentity,
} from "../kernel/caller-mint.ts";
import type { ProjectBindings } from "../project/contract.ts";
import type { WorkerRegistrations } from "../worker/contract.ts";
import { validText, signingKey } from "./local.ts";
import { unauthorized } from "./errors.ts";
const MILLISECONDS_PER_SECOND = 1000;
const BEARER_PREFIX_LENGTH = 7;
const clientIdentitySchema = identitySchema(CLIENT_IDENTITY_PREFIX);
export interface AuthenticationLookups {
  project: ProjectBindings;
  worker: Pick<WorkerRegistrations, "findByClient">;
}
export class Authentication {
  private readonly store: Store;
  private readonly key: Promise<CryptoKey>;
  private readonly machines?: AuthenticationLookups;
  private readonly denylist = new Map<string, number>();

  constructor(
    store: Store,
    masterKey: string,
    dependencies?: AuthenticationLookups,
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
    return mintMachineIdentity(
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
      return mintHumanIdentity(identity.accountId, identity.name, identity.jti);
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
      return mintHumanIdentity(claims.sub, claims.name, claims.jti);
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
