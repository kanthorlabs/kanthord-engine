import { verify } from "hono/jwt";
import { identitySchema, ulidSchema } from "../../kernel/identity.ts";
import { isString } from "../../kernel/values.ts";
import { background, type Context } from "../../kernel/context.ts";
import {
  type CallerIdentity,
  CLIENT_IDENTITY_PREFIX,
  CONNECTION_PREFIX,
  type HumanIdentity,
  IdentityKind,
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
  isWorkerIdentity,
  type MachineIdentity,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
  WORKER_INSTANCE_PREFIX,
  type WorkerIdentity,
} from "../../kernel/caller.ts";
import {
  mintHumanIdentity,
  mintMachineIdentity,
  mintWorkerIdentity,
} from "../../kernel/caller-mint.ts";
import {
  type ProjectBindings,
  WorkerPlacement,
} from "../../project/contract.ts";
import {
  type WorkerInstanceLookups,
  type WorkerRegistrations,
  workerResourceIdentitySchema,
} from "../../worker/contract.ts";
import { signingKey, validText } from "./jwt.ts";
import {
  JwtCause,
  jwtRefused,
  unauthorized,
  WorkerGroupEnded,
} from "../errors.ts";
const MILLISECONDS_PER_SECOND = 1000;
const BEARER_PREFIX_LENGTH = 7;
const clientIdentitySchema = identitySchema(CLIENT_IDENTITY_PREFIX);
const instanceIdentitySchema = identitySchema(WORKER_INSTANCE_PREFIX);
const connectionIdentitySchema = identitySchema(CONNECTION_PREFIX);
const projectIdentitySchema = identitySchema("project");
const ClaimType = { Text: "text", Integer: "integer" } as const;
type ClaimType = (typeof ClaimType)[keyof typeof ClaimType];
const CLAIM_TYPES: Readonly<Record<string, ClaimType>> = {
  sub: ClaimType.Text,
  name: ClaimType.Text,
  kind: ClaimType.Text,
  iat: ClaimType.Integer,
  exp: ClaimType.Integer,
  jti: ClaimType.Text,
  project_id: ClaimType.Text,
  resource_identity: ClaimType.Text,
  instance_id: ClaimType.Text,
  connection_id: ClaimType.Text,
};
const REQUIRED_CLAIMS = ["sub", "name", "kind", "iat", "exp", "jti"] as const;
const MACHINE_CLAIMS = ["project_id", "resource_identity"] as const;
const INSTANCE_CLAIMS = ["instance_id", "connection_id"] as const;
interface Claims {
  sub: string;
  name: string;
  kind: string;
  iat: number;
  exp: number;
  jti: string;
  project_id?: string;
  resource_identity?: string;
  instance_id?: string;
  connection_id?: string;
}
export interface AuthenticationLookups {
  project: Pick<ProjectBindings, "resolveWorkerGroup" | "workerGroupEnded">;
  worker: Pick<WorkerRegistrations, "findByClient" | "heartbeat">;
  instances?: WorkerInstanceLookups;
}

function hasType(value: unknown, type: ClaimType): boolean {
  return type === ClaimType.Text
    ? isString(value)
    : Number.isSafeInteger(value);
}

function closedClaims(claims: Record<string, unknown>): Claims {
  for (const key of Object.keys(claims))
    if (!Object.hasOwn(CLAIM_TYPES, key))
      throw jwtRefused(JwtCause.UnknownClaim);
  for (const [key, value] of Object.entries(claims))
    if (!hasType(value, CLAIM_TYPES[key]!))
      throw jwtRefused(JwtCause.InvalidType);
  for (const key of REQUIRED_CLAIMS)
    if (!(key in claims)) throw jwtRefused(JwtCause.MissingClaim);
  return claims as unknown as Claims;
}

function refuseTime(claims: Claims): void {
  const now = Math.floor(Date.now() / MILLISECONDS_PER_SECOND);
  if (claims.exp <= now) throw jwtRefused(JwtCause.Expired);
  if (claims.iat > now) throw jwtRefused(JwtCause.NotYetIssued);
}

function refuseCommonForms(claims: Claims): void {
  if (
    !validText(claims.name, MAX_DISPLAY_NAME_LENGTH) ||
    !ulidSchema.safeParse(claims.jti).success
  )
    throw jwtRefused(JwtCause.InvalidType);
}

function refuseForbidden(
  claims: Claims,
  names: readonly (keyof Claims)[],
): void {
  for (const name of names)
    if (name in claims) throw jwtRefused(JwtCause.ForbiddenClaim);
}

function refuseClientForms(claims: Claims): void {
  for (const name of MACHINE_CLAIMS)
    if (!(name in claims)) throw jwtRefused(JwtCause.MissingClaim);
  if (
    !clientIdentitySchema.safeParse(claims.sub).success ||
    !projectIdentitySchema.safeParse(claims.project_id).success ||
    !workerResourceIdentitySchema.safeParse(claims.resource_identity).success ||
    (claims.instance_id !== undefined &&
      !instanceIdentitySchema.safeParse(claims.instance_id).success) ||
    (claims.connection_id !== undefined &&
      !connectionIdentitySchema.safeParse(claims.connection_id).success)
  )
    throw jwtRefused(JwtCause.InvalidType);
}

export class Authentication {
  private readonly key: Promise<CryptoKey>;
  private readonly machines?: AuthenticationLookups;

  constructor(
    masterKey: string,
    authVersion: number,
    dependencies?: AuthenticationLookups,
  ) {
    this.key = signingKey(masterKey, authVersion);
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

  private refuseInstance(
    clientId: string,
    projectId: string,
    resourceIdentity: string,
    listed: readonly string[],
    instanceId: string | undefined,
    connectionId: string | undefined,
  ): void {
    if (instanceId === undefined || connectionId === undefined)
      throw jwtRefused(JwtCause.InstanceRequired);
    const instance = this.machines?.instances?.liveInstance(instanceId);
    if (!instance) throw jwtRefused(JwtCause.InstanceEnded);
    if (!listed.includes(instance.name)) {
      const registration = this.machines!.worker.findByClient(clientId);
      if (
        registration?.project_id !== projectId ||
        registration.resource_identity !== resourceIdentity
      )
        throw jwtRefused(JwtCause.InstanceNotListed);
    }
    if (!this.machines!.instances!.holdConnection(instanceId, connectionId))
      throw jwtRefused(JwtCause.ConnectionSuperseded);
  }

  private async resolveMachine(
    client: Omit<MachineIdentity, "kind" | "jti" | "runtimeIdentity">,
    jti: string,
    context: Context,
  ): Promise<MachineIdentity> {
    const resolved = await this.machines?.project.resolveWorkerGroup(
      client.projectId,
      client.resourceIdentity,
      client.issuedAt,
      context,
    );
    if (!resolved) {
      const ended = await this.machines?.project.workerGroupEnded(
        client.projectId,
        client.resourceIdentity,
        client.issuedAt,
        context,
      );
      throw ended ? new WorkerGroupEnded() : unauthorized();
    }
    if (
      resolved.project_id !== client.projectId ||
      resolved.resource_identity !== client.resourceIdentity
    )
      throw unauthorized();
    if (resolved.placement === WorkerPlacement.Worker)
      this.refuseInstance(
        client.clientId,
        resolved.project_id,
        resolved.resource_identity,
        resolved.worker_instances ?? [],
        client.instanceId,
        client.connectionId,
      );
    else if (
      client.instanceId !== undefined ||
      client.connectionId !== undefined
    )
      throw jwtRefused(JwtCause.ForbiddenClaim);
    const registration = this.machines!.worker.findByClient(client.clientId);
    if (
      registration &&
      (registration.client_id !== client.clientId ||
        registration.resource_identity !== resolved.resource_identity ||
        registration.project_id !== resolved.project_id)
    )
      throw unauthorized();
    return mintMachineIdentity(
      {
        ...client,
        projectId: resolved.project_id,
        resourceIdentity: resolved.resource_identity,
      },
      jti,
      registration?.runtime_identity,
    );
  }

  private resolveWorker(
    instanceId: string,
    name: string,
    jti: string,
  ): WorkerIdentity {
    const instance = this.machines?.instances?.liveInstance(instanceId);
    if (!instance) throw jwtRefused(JwtCause.InstanceEnded);
    return mintWorkerIdentity(instanceId, name, jti);
  }

  async recheck(
    identity: CallerIdentity,
    context: Context,
    requiresRegistration = true,
  ): Promise<CallerIdentity> {
    if (isHumanIdentity(identity))
      return mintHumanIdentity(identity.accountId, identity.name, identity.jti);
    if (isServiceIdentity(identity)) return identity;
    if (isWorkerIdentity(identity))
      return this.resolveWorker(
        identity.instanceId,
        identity.name,
        identity.jti,
      );
    if (!isMachineIdentity(identity)) throw unauthorized();
    const current = await this.resolveMachine(
      {
        clientId: identity.clientId,
        name: identity.name,
        projectId: identity.projectId,
        resourceIdentity: identity.resourceIdentity,
        issuedAt: identity.issuedAt,
        instanceId: identity.instanceId,
        connectionId: identity.connectionId,
      },
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
  ): Promise<HumanIdentity | MachineIdentity | WorkerIdentity> {
    if (!authorization || !/^Bearer [^\s,]+$/i.test(authorization))
      throw unauthorized();
    const key = await this.key;
    let verified;
    try {
      verified = await verify(authorization.slice(BEARER_PREFIX_LENGTH), key, {
        alg: "HS256",
        exp: false,
        iat: false,
        nbf: false,
      });
    } catch {
      throw unauthorized();
    }
    const claims = closedClaims(verified);
    refuseTime(claims);
    refuseCommonForms(claims);
    if (claims.kind === IdentityKind.Human) {
      refuseForbidden(claims, [...MACHINE_CLAIMS, ...INSTANCE_CLAIMS]);
      if (!validText(claims.sub, MAX_HUMAN_USERNAME_LENGTH))
        throw jwtRefused(JwtCause.InvalidType);
      return mintHumanIdentity(claims.sub, claims.name, claims.jti);
    }
    if (claims.kind === IdentityKind.Worker) {
      refuseForbidden(claims, [...MACHINE_CLAIMS, ...INSTANCE_CLAIMS]);
      if (!instanceIdentitySchema.safeParse(claims.sub).success)
        throw jwtRefused(JwtCause.InvalidType);
      return this.resolveWorker(claims.sub, claims.name, claims.jti);
    }
    if (claims.kind !== IdentityKind.Client)
      throw jwtRefused(JwtCause.InvalidType);
    refuseClientForms(claims);
    const identity = await this.resolveMachine(
      {
        clientId: claims.sub,
        name: claims.name,
        projectId: claims.project_id!,
        resourceIdentity: claims.resource_identity!,
        issuedAt: claims.iat * MILLISECONDS_PER_SECOND,
        ...(claims.instance_id === undefined
          ? {}
          : { instanceId: claims.instance_id }),
        ...(claims.connection_id === undefined
          ? {}
          : { connectionId: claims.connection_id }),
      },
      claims.jti,
      context,
    );
    if (identity.runtimeIdentity)
      this.machines!.worker.heartbeat(identity.runtimeIdentity);
    return identity;
  }
}
