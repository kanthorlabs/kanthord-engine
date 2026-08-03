import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { objectId, epochMillis, bytes } from "./column.ts";

describe("src/domain/column.test", () => {
  it("objectId accepts 40-char hex", () => {
    assert.equal(objectId.safeParse("a".repeat(40)).success, true);
  });

  it("objectId accepts 64-char hex", () => {
    assert.equal(objectId.safeParse("a".repeat(64)).success, true);
  });

  it("objectId rejects 39-char hex", () => {
    assert.equal(objectId.safeParse("a".repeat(39)).success, false);
  });

  it("objectId rejects 41-char hex", () => {
    assert.equal(objectId.safeParse("a".repeat(41)).success, false);
  });

  it("objectId rejects uppercase", () => {
    assert.equal(objectId.safeParse("A".repeat(40)).success, false);
  });

  it("objectId rejects empty string", () => {
    assert.equal(objectId.safeParse("").success, false);
  });

  it("epochMillis accepts 0", () => {
    assert.equal(epochMillis.safeParse(0).success, true);
  });

  it("epochMillis accepts 1735689600000", () => {
    assert.equal(epochMillis.safeParse(1735689600000).success, true);
  });

  it("epochMillis rejects 1.5", () => {
    assert.equal(epochMillis.safeParse(1.5).success, false);
  });

  it("epochMillis rejects string", () => {
    assert.equal(epochMillis.safeParse("0").success, false);
  });

  it("bytes accepts Uint8Array", () => {
    assert.equal(bytes.safeParse(new Uint8Array(3)).success, true);
  });

  it("bytes rejects array", () => {
    assert.equal(bytes.safeParse([0, 0, 0]).success, false);
  });

  it("bytes rejects string", () => {
    assert.equal(bytes.safeParse("abc").success, false);
  });
});
