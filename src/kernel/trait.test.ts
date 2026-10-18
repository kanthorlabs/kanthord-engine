import assert from "node:assert/strict";
import { test } from "node:test";
import { TRAIT_KEY_MAX_BYTES, traitKeySchema } from "./trait.ts";

function keyOfBytes(bytes: number): string {
  return `platform.${"a".repeat(bytes - "platform.".length)}`;
}

test("a trait key of 64 bytes passes and 65 bytes fails", () => {
  assert.equal(
    traitKeySchema.safeParse(keyOfBytes(TRAIT_KEY_MAX_BYTES)).success,
    true,
  );
  assert.equal(
    traitKeySchema.safeParse(keyOfBytes(TRAIT_KEY_MAX_BYTES + 1)).success,
    false,
  );
});

test("a trait key takes lower-case segments separated by dots", () => {
  for (const key of ["platform", "platform.macos", "toolchain.xcode_16"])
    assert.equal(traitKeySchema.safeParse(key).success, true, key);
  for (const key of [
    "platform.macOS",
    "",
    "1platform",
    "platform.",
    ".platform",
    "platform..macos",
    "platform-macos",
  ])
    assert.equal(traitKeySchema.safeParse(key).success, false, key);
});
