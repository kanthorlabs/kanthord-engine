import { mintHumanIdentity, mintMachineIdentity } from "./caller-mint.ts";
import type { HumanIdentity, MachineIdentity } from "./caller.ts";

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
