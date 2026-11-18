import assert from "node:assert/strict";
import { identitySchema } from "./identity.ts";
import {
  callerProvenance,
  CLIENT_IDENTITY_PREFIX,
  type GuestIdentity,
  type HumanIdentity,
  IdentityKind,
  isReadOnlyIdentity,
  type MachineIdentity,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_HUMAN_USERNAME_LENGTH,
  WORKER_INSTANCE_PREFIX,
  type WorkerIdentity,
} from "./caller.ts";
const clientIdentitySchema = identitySchema(CLIENT_IDENTITY_PREFIX);
export function mintHumanIdentity(
  accountId: string,
  name: string,
  jti: string,
): HumanIdentity {
  assert.ok(accountId.trim() && accountId.length <= MAX_HUMAN_USERNAME_LENGTH);
  assert.ok(name.trim() && name.length <= MAX_DISPLAY_NAME_LENGTH);
  const value = Object.freeze({
    kind: IdentityKind.Human,
    accountId,
    name,
    jti,
  });
  callerProvenance.human(value);
  return value;
}

export interface ReadOnlyGrant {
  inviteId: string;
  projectIds: readonly string[];
}

export function mintReadOnlyIdentity(
  accountId: string,
  grant: ReadOnlyGrant,
): HumanIdentity {
  assert.ok(accountId.trim() && accountId.length <= MAX_HUMAN_USERNAME_LENGTH);
  assert.ok(grant.inviteId.trim());
  const value = Object.freeze({
    kind: IdentityKind.Human,
    accountId,
    name: accountId,
    jti: `reader:${grant.inviteId}`,
  });
  callerProvenance.reader(value, {
    inviteId: grant.inviteId,
    projects: Object.freeze(new Set(grant.projectIds)),
  });
  return value;
}

export function mintGuestIdentity(
  guest: Omit<GuestIdentity, "kind">,
): GuestIdentity {
  assert.ok(
    guest.guestId.trim() && guest.guestId.length <= MAX_HUMAN_USERNAME_LENGTH,
  );
  assert.ok(guest.name.trim() && guest.name.length <= MAX_DISPLAY_NAME_LENGTH);
  assert.ok(guest.inviteId.trim());
  assert.ok(guest.sessionId.trim());
  assert.ok(guest.invitedBy.trim());
  assert.ok(isReadOnlyIdentity(guest.reader));
  const value = Object.freeze({
    kind: IdentityKind.Guest,
    guestId: guest.guestId,
    name: guest.name,
    inviteId: guest.inviteId,
    sessionId: guest.sessionId,
    invitedBy: guest.invitedBy,
    reader: guest.reader,
    jti: guest.jti,
  });
  callerProvenance.guest(value);
  return value;
}

export function mintWorkerIdentity(
  instanceId: string,
  name: string,
  jti: string,
): WorkerIdentity {
  assert.ok(
    identitySchema(WORKER_INSTANCE_PREFIX).safeParse(instanceId).success,
  );
  assert.ok(name.trim() && name.length <= MAX_DISPLAY_NAME_LENGTH);
  const value = Object.freeze({
    kind: IdentityKind.Worker,
    instanceId,
    name,
    jti,
  });
  callerProvenance.worker(value);
  return value;
}

export function mintMachineIdentity(
  client: Omit<MachineIdentity, "kind" | "jti" | "runtimeIdentity">,
  jti: string,
  runtimeIdentity?: string,
): MachineIdentity {
  assert.ok(clientIdentitySchema.safeParse(client.clientId).success);
  assert.ok(
    client.name.trim() && client.name.length <= MAX_DISPLAY_NAME_LENGTH,
  );
  const value = Object.freeze({
    kind: IdentityKind.Client,
    clientId: client.clientId,
    name: client.name,
    resourceIdentity: client.resourceIdentity,
    issuedAt: client.issuedAt,
    projectId: client.projectId,
    ...(client.instanceId === undefined
      ? {}
      : { instanceId: client.instanceId }),
    ...(client.connectionId === undefined
      ? {}
      : { connectionId: client.connectionId }),
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    jti,
  });
  callerProvenance.machine(value);
  return value;
}
