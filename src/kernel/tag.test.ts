import assert from "node:assert/strict";
import { test } from "node:test";
import { TAG_MAX_BYTES, tagSchema } from "./tag.ts";

function keyOfBytes(bytes: number): string {
  return `platform.${"a".repeat(bytes - "platform.".length)}`;
}

test("a tag of 64 bytes passes and 65 bytes fails", () => {
  assert.equal(tagSchema.safeParse(keyOfBytes(TAG_MAX_BYTES)).success, true);
  assert.equal(
    tagSchema.safeParse(keyOfBytes(TAG_MAX_BYTES + 1)).success,
    false,
  );
});

test("a tag takes lower-case segments separated by dots", () => {
  for (const key of ["platform", "platform.macos", "toolchain.xcode_16"])
    assert.equal(tagSchema.safeParse(key).success, true, key);
  for (const key of [
    "platform.macOS",
    "",
    "1platform",
    "platform.",
    ".platform",
    "platform..macos",
    "platform-macos",
  ])
    assert.equal(tagSchema.safeParse(key).success, false, key);
});
