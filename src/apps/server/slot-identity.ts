import { CLIENT_IDENTITY_PREFIX } from "../../kernel/caller.ts";
import { ULID_LENGTH } from "../../kernel/identity.ts";
import { deriveKey } from "../../kernel/json.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BITS_PER_CHARACTER = 5n;
const CHARACTER_MASK = 31n;
const IDENTITY_BYTES = 16;
const LABEL_PREFIX = "worker/server-client";

export function slotClientIdentity(
  masterKey: string,
  projectId: string,
  resourceIdentity: string,
  generation: number,
  slot: number,
): string {
  const key = deriveKey(
    masterKey,
    [LABEL_PREFIX, projectId, resourceIdentity, generation, slot].join("/"),
  );
  let value = BigInt(`0x${key.subarray(0, IDENTITY_BYTES).toString("hex")}`);
  let text = "";
  for (let index = 0; index < ULID_LENGTH; index++) {
    text = `${CROCKFORD[Number(value & CHARACTER_MASK)]}${text}`;
    value >>= BITS_PER_CHARACTER;
  }
  return `${CLIENT_IDENTITY_PREFIX}_${text}`;
}
