import assert from "node:assert/strict";
import { identitySchema } from "./identity.ts";
import {
  callerProvenance,
  IdentityKind,
  CLIENT_IDENTITY_PREFIX,
  MAX_HUMAN_USERNAME_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  type HumanIdentity,
  type MachineIdentity,
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
    workerBindingId: client.workerBindingId,
    projectId: client.projectId,
    ...(runtimeIdentity === undefined ? {} : { runtimeIdentity }),
    jti,
  });
  callerProvenance.machine(value);
  return value;
}
