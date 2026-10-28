import { ULID_LENGTH } from "../../kernel/identity.ts";
import { deriveKey } from "../../kernel/json.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const BITS_PER_CHARACTER = 5n;
const CHARACTER_MASK = 31n;
const IDENTITY_BYTES = 16;

export function derivedCrockford(masterKey: string, label: string): string {
  const key = deriveKey(masterKey, label);
  let value = BigInt(`0x${key.subarray(0, IDENTITY_BYTES).toString("hex")}`);
  let text = "";
  for (let index = 0; index < ULID_LENGTH; index++) {
    text = `${CROCKFORD[Number(value & CHARACTER_MASK)]}${text}`;
    value >>= BITS_PER_CHARACTER;
  }
  return text;
}
