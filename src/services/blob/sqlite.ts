import { createHash } from "node:crypto";

import type { Clock } from "../clock/index.ts";
import type { Storage, Transaction } from "../storage/index.ts";
import { BlobStoreError } from "./index.ts";
import type { BlobRecord, BlobStore } from "./index.ts";

export type SqliteBlobStoreDependencies = Readonly<{
  storage: Storage;
  clock: Clock;
}>;

const blobHashPattern = /^sha256:[0-9a-f]{64}$/;

export class SqliteBlobStore implements BlobStore {
  private readonly storage: Storage;
  private readonly clock: Clock;

  constructor(dependencies: SqliteBlobStoreDependencies) {
    this.storage = dependencies.storage;
    this.clock = dependencies.clock;
  }

  put(transaction: Transaction, content: Uint8Array): string {
    const hash = this.hash(content);
    transaction.run(
      "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING",
      [hash, content.byteLength, content, this.clock.now()],
    );
    return hash;
  }

  hash(content: Uint8Array): string {
    return `sha256:${createHash("sha256").update(content).digest("hex")}`;
  }

  get(hash: string, transaction?: Transaction): BlobRecord | null {
    if (!blobHashPattern.test(hash)) {
      throw new BlobStoreError(
        "blob-hash-invalid",
        `${hash} is not a sha256 blob hash`,
      );
    }
    const read = (open: Transaction): unknown =>
      open.get(
        "SELECT hash, size, content, created_at FROM blob WHERE hash = ?",
        [hash],
      );
    const row =
      transaction === undefined
        ? this.storage.transact(read)
        : read(transaction);
    if (row === undefined) {
      return null;
    }
    const record = row as Readonly<{
      hash: string;
      size: number;
      content: Uint8Array;
      created_at: number;
    }>;
    return {
      hash: record.hash,
      size: record.size,
      content: record.content,
      createdAt: record.created_at,
    };
  }
}
