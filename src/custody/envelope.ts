import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { canonicalJSON, deriveKey } from "../kernel/json.ts";

export const CIPHER_ALGORITHM = "aes-256-gcm";
export const CIPHER_KEY_LABEL = "custody/aes-256-gcm/v1";
export const NONCE_BYTES = 12;
export const TAG_BYTES = 16;
export const AAD_LENGTH_FIELD_SIZE = 4;

export function deriveEnvelopeKey(masterKey: string): Buffer {
  return deriveKey(masterKey, CIPHER_KEY_LABEL);
}

function lengthPrefixedUtf8(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.alloc(AAD_LENGTH_FIELD_SIZE);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function buildAad(id: string, platform: string): Buffer {
  return Buffer.concat([lengthPrefixedUtf8(id), lengthPrefixedUtf8(platform)]);
}

export function encrypt(
  key: Buffer,
  id: string,
  platform: string,
  secret: unknown,
): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(CIPHER_ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(buildAad(id, platform));
  const ciphertext = Buffer.concat([
    cipher.update(canonicalJSON(secret), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { nonce, ciphertext };
}

export function decrypt(
  key: Buffer,
  id: string,
  platform: string,
  nonce: Buffer,
  ciphertext: Buffer,
): unknown {
  if (nonce.length !== NONCE_BYTES) throw new Error("Invalid nonce length.");
  if (ciphertext.length <= TAG_BYTES)
    throw new Error("Invalid ciphertext length.");

  const tag = ciphertext.subarray(ciphertext.length - TAG_BYTES);
  const decipher = createDecipheriv(CIPHER_ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(buildAad(id, platform));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES)),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}
