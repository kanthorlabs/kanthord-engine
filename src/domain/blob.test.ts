import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { blobHash, blobRow } from "./blob.ts";

const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/blob.test", () => {
  it("blobHash accepts valid hash", () => {
    assert.equal(blobHash.safeParse(HASH).success, true);
  });

  it("blobHash rejects missing algorithm prefix", () => {
    assert.equal(blobHash.safeParse("0".repeat(64)).success, false);
  });

  it("blobHash rejects short hex", () => {
    assert.equal(blobHash.safeParse("sha256:" + "0".repeat(63)).success, false);
  });

  it("blobHash rejects uppercase hex", () => {
    assert.equal(blobHash.safeParse("sha256:" + "A".repeat(64)).success, false);
  });

  it("blobHash rejects wrong algorithm", () => {
    assert.equal(blobHash.safeParse("sha1:" + "0".repeat(40)).success, false);
  });

  it("blobRow accepts valid row", () => {
    const result = blobRow.safeParse({
      hash: HASH,
      size: 3,
      content: new Uint8Array(3),
      createdAt: 0,
    });
    assert.equal(result.success, true);
  });

  it("blobRow rejects invalid hash", () => {
    const result = blobRow.safeParse({
      hash: "0".repeat(64),
      size: 3,
      content: new Uint8Array(3),
      createdAt: 0,
    });
    assert.equal(result.success, false);
  });
});
