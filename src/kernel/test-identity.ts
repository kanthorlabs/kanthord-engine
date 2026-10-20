import {
  mintHumanIdentity,
  mintMachineIdentity,
  mintWorkerIdentity,
} from "./caller-mint.ts";
import type {
  HumanIdentity,
  MachineIdentity,
  WorkerIdentity,
} from "./caller.ts";

export function testHumanIdentity(
  accountId: string,
  name: string,
  jti: string,
): HumanIdentity {
  return mintHumanIdentity(accountId, name, jti);
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
