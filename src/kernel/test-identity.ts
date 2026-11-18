import {
  type DelegateIdentityOptions,
  mintDelegateIdentity,
  mintGuestIdentity,
  mintHumanIdentity,
  mintMachineIdentity,
  mintReadOnlyIdentity,
  mintWorkerIdentity,
  type ReadOnlyGrant,
} from "./caller-mint.ts";
import { mintServiceIdentity } from "./service-mint.ts";
import type {
  GuestIdentity,
  HumanIdentity,
  MachineIdentity,
  ServiceIdentity,
  WorkerIdentity,
} from "./caller.ts";

export function testHumanIdentity(
  accountId: string,
  name: string,
  jti: string,
): HumanIdentity {
  return mintHumanIdentity(accountId, name, jti);
}

export function testReadOnlyIdentity(
  accountId: string,
  grant: ReadOnlyGrant,
): HumanIdentity {
  return mintReadOnlyIdentity(accountId, grant);
}

export function testDelegateIdentity(
  accountId: string,
  options: DelegateIdentityOptions,
): HumanIdentity {
  return mintDelegateIdentity(accountId, options);
}

export function testMachineIdentity(
  client: Omit<MachineIdentity, "kind" | "jti" | "runtimeIdentity">,
  jti: string,
  runtimeIdentity?: string,
): MachineIdentity {
  return mintMachineIdentity(client, jti, runtimeIdentity);
}

export function testWorkerIdentity(
  instanceId: string,
  name: string,
  jti: string,
): WorkerIdentity {
  return mintWorkerIdentity(instanceId, name, jti);
}

export function testGuestIdentity(
  guest: Omit<GuestIdentity, "kind">,
): GuestIdentity {
  return mintGuestIdentity(guest);
}

export function testServiceIdentity(service: string): ServiceIdentity {
  return mintServiceIdentity(service);
}
