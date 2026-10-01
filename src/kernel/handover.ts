import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJSON, deriveKey } from "./json.ts";

export const HANDOVER_KEY_INFO = "handover/server-to-worker/v1";
export const REPORT_KEY_INFO = "handover/worker-to-server/v1";
export const HANDOVER_CIPHER = "aes-256-gcm";
export const HANDOVER_NONCE_BYTES = 12;
export const HANDOVER_TAG_BYTES = 16;
export const HANDOVER_AAD_LENGTH_BYTES = 4;
const KEY_BYTES = 32;
const LENGTH_MAX = 0xffffffff;

export const handoverEnvelopeSchema = z.strictObject({
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
});
export type HandoverEnvelope = z.infer<typeof handoverEnvelopeSchema>;

export class HandoverOpenError extends Error {
  constructor() {
    super("The handover envelope is invalid.");
    this.name = "HandoverOpenError";
  }
}

export function deriveHandoverKeys(clientSecret: string): {
  handover: Buffer;
  report: Buffer;
} {
  const handover = deriveKey(clientSecret, HANDOVER_KEY_INFO);
  const report = deriveKey(clientSecret, REPORT_KEY_INFO);
  assert.equal(handover.length, KEY_BYTES);
  assert.equal(report.length, KEY_BYTES);
  return { handover, report };
}

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  assert(value.isWellFormed());
  assert(bytes.length <= LENGTH_MAX);
  const length = Buffer.alloc(HANDOVER_AAD_LENGTH_BYTES);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

export function handoverAad(
  executionId: string,
  runtimeIdentity: string,
): Buffer {
  assert(executionId.length);
  assert(runtimeIdentity.length);
  return Buffer.concat([
    lengthPrefixed(executionId),
    lengthPrefixed(runtimeIdentity),
  ]);
}

export function sealEnvelope(
  key: Buffer,
  aad: Buffer,
  value: unknown,
): HandoverEnvelope {
  assert.equal(key.length, KEY_BYTES);
  assert(aad.length);
  const nonce = randomBytes(HANDOVER_NONCE_BYTES);
  const cipher = createCipheriv(HANDOVER_CIPHER, key, nonce, {
    authTagLength: HANDOVER_TAG_BYTES,
  });
  cipher.setAAD(aad);
  const plaintext = Buffer.from(canonicalJSON(value), "utf8");
  try {
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      nonce: nonce.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  } finally {
    plaintext.fill(0);
  }
}

export function openEnvelope(
  key: Buffer,
  aad: Buffer,
  envelope: HandoverEnvelope,
): unknown {
  let plaintext: Buffer | undefined;
  try {
    const input = handoverEnvelopeSchema.parse(envelope);
    const nonce = Buffer.from(input.nonce, "base64");
    const ciphertext = Buffer.from(input.ciphertext, "base64");
    assert.equal(nonce.toString("base64"), input.nonce);
    assert.equal(ciphertext.toString("base64"), input.ciphertext);
    assert.equal(nonce.length, HANDOVER_NONCE_BYTES);
    assert(ciphertext.length > HANDOVER_TAG_BYTES);
    const decipher = createDecipheriv(HANDOVER_CIPHER, key, nonce, {
      authTagLength: HANDOVER_TAG_BYTES,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(ciphertext.subarray(-HANDOVER_TAG_BYTES));
    plaintext = Buffer.concat([
      decipher.update(ciphertext.subarray(0, -HANDOVER_TAG_BYTES)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new HandoverOpenError();
  } finally {
    plaintext?.fill(0);
  }
}
