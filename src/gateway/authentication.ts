import { verify } from "hono/jwt";
import { identitySchema } from "../kernel/identity.ts";
import { isString } from "../kernel/values.ts";
import { background, type Context } from "../kernel/context.ts";
import {
  IdentityKind,
  CLIENT_IDENTITY_PREFIX,
  MAX_HUMAN_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
  type HumanIdentity,
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
  project: Pick<ProjectBindings, "resolveWorkerGroup">;
  worker: Pick<WorkerRegistrations, "findByClient" | "heartbeat">;
}
export class Authentication {
  private readonly key: Promise<CryptoKey>;
  private readonly machines?: AuthenticationLookups;

  constructor(masterKey: string, dependencies?: AuthenticationLookups) {
    this.key = signingKey(masterKey);
    this.machines = dependencies;
  }

  async healthcheck(): Promise<boolean> {
    try {
      await this.key;
      return true;
    } catch {
      return false;
    }
  }

  private async resolveMachine(
    clientId: string,
    name: string,
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    jti: string,
    context: Context,
  ): Promise<MachineIdentity> {
    const resolved = await this.machines?.project.resolveWorkerGroup(
      projectId,
      resourceIdentity,
      issuedAt,
      context,
    );
    if (
      !resolved ||
      resolved.project_id !== projectId ||
      resolved.resource_identity !== resourceIdentity
    )
      throw unauthorized();
    const registration = this.machines!.worker.findByClient(clientId);
    if (
      registration &&
      (registration.client_id !== clientId ||
        registration.resource_identity !== resolved.resource_identity ||
        registration.project_id !== resolved.project_id)
    )
      throw unauthorized();
    return mintMachineIdentity(
      {
        clientId,
        name,
        projectId: resolved.project_id,
        resourceIdentity: resolved.resource_identity,
        issuedAt,
      },
      jti,
      registration?.runtime_identity,
    );
  }

  async recheck(
    identity: CallerIdentity,
    context: Context,
    requiresRegistration = true,
  ): Promise<CallerIdentity> {
    if (isHumanIdentity(identity))
      return mintHumanIdentity(identity.accountId, identity.name, identity.jti);
    if (isServiceIdentity(identity)) return identity;
    if (!isMachineIdentity(identity)) throw unauthorized();
    const current = await this.resolveMachine(
      identity.clientId,
      identity.name,
      identity.projectId,
      identity.resourceIdentity,
      identity.issuedAt,
      identity.jti,
      context,
    );
    if (
      requiresRegistration &&
      current.runtimeIdentity !== identity.runtimeIdentity
    )
      throw unauthorized();
    if (current.runtimeIdentity)
      this.machines!.worker.heartbeat(current.runtimeIdentity);
    return current;
  }

  async authenticate(
    authorization: string | undefined,
    context: Context = background,
  ): Promise<HumanIdentity | MachineIdentity> {
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
      "binding" in claims ||
      !isString(claims.jti) ||
      !Number.isSafeInteger(claims.iat) ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp! <= Math.floor(Date.now() / MILLISECONDS_PER_SECOND) ||
      !validText(claims.name, MAX_DISPLAY_NAME_LENGTH)
    )
      throw unauthorized();
    if (claims.kind === IdentityKind.Human) {
      if (
        !validText(claims.sub, MAX_HUMAN_USERNAME_LENGTH) ||
        "project_id" in claims ||
        "resource_identity" in claims ||
        "reg" in claims
      )
        throw unauthorized();
      return mintHumanIdentity(claims.sub, claims.name, claims.jti);
    }
    if (
      claims.kind !== IdentityKind.Client ||
      !isString(claims.sub) ||
      !clientIdentitySchema.safeParse(claims.sub).success ||
      !isString(claims.project_id) ||
      !identitySchema("project").safeParse(claims.project_id).success ||
      !isString(claims.resource_identity)
    )
      throw unauthorized();
    const identity = await this.resolveMachine(
      claims.sub!,
      claims.name,
      claims.project_id,
      claims.resource_identity,
      claims.iat! * MILLISECONDS_PER_SECOND,
      claims.jti,
      context,
    );
    if (identity.runtimeIdentity)
      this.machines!.worker.heartbeat(identity.runtimeIdentity);
    return identity;
  }
}
