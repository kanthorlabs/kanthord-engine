import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { showBlob } from "./show-blob.ts";
import type { BlobStore, BlobRecord } from "../../services/blob/index.ts";

function makeMock(result: BlobRecord | null): {
  blobs: BlobStore;
  calls: { hash: string; transaction: unknown }[];
} {
  const calls: { hash: string; transaction: unknown }[] = [];
  const blobs: BlobStore = {
    put: () => {
      throw new Error("put must not be called");
    },
    get: (hash, transaction) => {
      calls.push({ hash, transaction });
      return result;
    },
    hash: () => {
      throw new Error("hash must not be called");
    },
  };
  return { blobs, calls };
}

const record: BlobRecord = {
  hash: `sha256:${"a".repeat(64)}`,
  size: 10,
  content: Buffer.from("0123456789"),
  createdAt: 1700000000000,
};

describe("src/queries/blob/show-blob.test", () => {
  it("forwards the hash byte for byte with no transaction", () => {
    const { blobs, calls } = makeMock(record);
    showBlob({ blobs }, { hash: record.hash });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.hash, record.hash);
    assert.equal(calls[0]?.transaction, undefined);
  });

  it("returns the record by identity", () => {
    const { blobs } = makeMock(record);
    assert.strictEqual(showBlob({ blobs }, { hash: record.hash }), record);
  });

  it("returns null when the store returns null", () => {
    const { blobs } = makeMock(null);
    assert.equal(showBlob({ blobs }, { hash: record.hash }), null);
  });
});
