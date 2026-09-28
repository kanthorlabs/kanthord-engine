import { mintHumanIdentity } from "./caller-mint.ts";
import type { HumanIdentity } from "./caller.ts";

export function testHumanIdentity(
  accountId: string,
  name: string,
  jti: string,
): HumanIdentity {
  return mintHumanIdentity(accountId, name, jti);
}
