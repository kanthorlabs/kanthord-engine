import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  Aes128Gcm,
  CipherSuite,
  DhkemX25519HkdfSha256,
  HkdfSha256,
} from "@hpke/core";
import { z } from "zod";
import { canonicalJSON } from "./json.ts";

export const X25519_KEY_BYTES = 32;
export const SEALED_ALGORITHM = "hpke-x25519-sha256-aes128gcm";
const FINGERPRINT_PREFIX = "SHA256:";
const BASE64URL = "base64url";
const UTF8 = "utf8";
const ZERO_BYTE = 0;

export const hpkeSuite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes128Gcm(),
});

const base64urlPattern = /^[A-Za-z0-9_-]+$/;
export const base64urlSchema = z.string().min(1).regex(base64urlPattern);

export const sealedObjectSchema = z.strictObject({
  alg: z.literal(SEALED_ALGORITHM),
  enc: base64urlSchema,
  ciphertext: base64urlSchema,
});
export type SealedObject = z.infer<typeof sealedObjectSchema>;

export class SealedOpenError extends Error {
  constructor() {
    super("The sealed object cannot be opened.");
    this.name = "SealedOpenError";
  }
}

export interface X25519KeyPair {
  public_key: Buffer;
  private_key: Buffer;
}

export function decodeX25519Key(value: string): Buffer | null {
  if (!base64urlPattern.test(value)) return null;
  const bytes = Buffer.from(value, BASE64URL);
  if (bytes.length !== X25519_KEY_BYTES) return null;
  if (bytes.toString(BASE64URL) !== value) return null;
  if (bytes.every((byte) => byte === ZERO_BYTE)) return null;
  return bytes;
}

export function keyFingerprint(publicKey: Uint8Array): string {
  assert.equal(publicKey.length, X25519_KEY_BYTES);
  const hash = createHash("sha256").update(publicKey).digest("base64");
  return `${FINGERPRINT_PREFIX}${hash.replace(/=+$/, "")}`;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const pair = await hpkeSuite.kem.generateKeyPair();
  const publicKey = Buffer.from(
    await hpkeSuite.kem.serializePublicKey(pair.publicKey),
  );
  const privateKey = Buffer.from(
    await hpkeSuite.kem.serializePrivateKey(pair.privateKey),
  );
  assert.equal(publicKey.length, X25519_KEY_BYTES);
  assert.equal(privateKey.length, X25519_KEY_BYTES);
  return { public_key: publicKey, private_key: privateKey };
}

export async function sealBytes(
  publicKey: Uint8Array,
  info: string,
  aad: string,
  plaintext: Uint8Array,
): Promise<SealedObject> {
  assert.equal(publicKey.length, X25519_KEY_BYTES);
  const recipientPublicKey =
    await hpkeSuite.kem.deserializePublicKey(publicKey);
  const sealed = await hpkeSuite.seal(
    { recipientPublicKey, info: Buffer.from(info, UTF8) },
    plaintext,
    Buffer.from(aad, UTF8),
  );
  return {
    alg: SEALED_ALGORITHM,
    enc: Buffer.from(sealed.enc).toString(BASE64URL),
    ciphertext: Buffer.from(sealed.ct).toString(BASE64URL),
  };
}

export async function openBytes(
  privateKey: Uint8Array,
  info: string,
  aad: string,
  sealed: SealedObject,
): Promise<Buffer> {
  assert.equal(privateKey.length, X25519_KEY_BYTES);
  try {
    const recipientKey = await hpkeSuite.kem.deserializePrivateKey(privateKey);
    const plaintext = await hpkeSuite.open(
      {
        recipientKey,
        enc: Buffer.from(sealed.enc, BASE64URL),
        info: Buffer.from(info, UTF8),
      },
      Buffer.from(sealed.ciphertext, BASE64URL),
      Buffer.from(aad, UTF8),
    );
    return Buffer.from(plaintext);
  } catch {
    throw new SealedOpenError();
  }
}

export function sealJSON(
  publicKey: Uint8Array,
  info: string,
  aad: string,
  value: unknown,
): Promise<SealedObject> {
  const plaintext = Buffer.from(canonicalJSON(value), UTF8);
  return sealBytes(publicKey, info, aad, plaintext).finally(() =>
    plaintext.fill(ZERO_BYTE),
  );
}

export async function openJSON(
  privateKey: Uint8Array,
  info: string,
  aad: string,
  sealed: SealedObject,
): Promise<unknown> {
  const plaintext = await openBytes(privateKey, info, aad, sealed);
  try {
    return JSON.parse(plaintext.toString(UTF8));
  } catch {
    throw new SealedOpenError();
  } finally {
    plaintext.fill(ZERO_BYTE);
  }
}
