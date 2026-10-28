import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { type SealedObject, sealedObjectSchema } from "../kernel/hpke.ts";
import { HttpStatus } from "../kernel/http.ts";
import { SERVER_HOLDER } from "./contract.ts";
import { decrypt } from "./envelope.ts";

export const CREDENTIAL_HELD_BY_INSTANCE =
  "credential.credential.held_by_instance";

export type StoredRow = {
  id: string;
  platform: string;
  holder: string;
  nonce: Buffer;
  ciphertext: Buffer;
};

export function heldByInstance(): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    CREDENTIAL_HELD_BY_INSTANCE,
    "A worker instance holds the credential copy, and the server holds no secret of it.",
  );
}

export function openSecret(key: Buffer, row: StoredRow): unknown {
  if (row.holder !== SERVER_HOLDER) throw heldByInstance();
  return decrypt(key, row.id, row.platform, row.nonce, row.ciphertext);
}

export function storedSealed(key: Buffer, row: StoredRow): SealedObject {
  assert.notEqual(row.holder, SERVER_HOLDER);
  return sealedObjectSchema.parse(
    decrypt(key, row.id, row.platform, row.nonce, row.ciphertext),
  );
}
