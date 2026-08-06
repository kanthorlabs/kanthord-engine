import type { Transaction } from "../storage/index.ts";

export type BlobRecord = Readonly<{
  hash: string;
  size: number;
  content: Uint8Array;
  createdAt: number;
}>;

export type BlobStoreErrorCode = "blob-hash-invalid";

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode;
  constructor(code: BlobStoreErrorCode, message: string) {
    super(message);
    this.name = "BlobStoreError";
    this.code = code;
  }
}

export interface BlobStore {
  put(transaction: Transaction, content: Uint8Array): string;
  get(hash: string, transaction?: Transaction): BlobRecord | null;
  hash(content: Uint8Array): string;
}
