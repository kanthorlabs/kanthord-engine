import assert from "node:assert/strict";
import { isObject } from "../kernel/values.ts";
import { platformAddressSchema, type PlatformAddress } from "./contract.ts";
import type { ResultCodec } from "./outbound.ts";

export type StoredAddress = PlatformAddress;

export function encodeAddress(address: PlatformAddress): StoredAddress {
  const stored = platformAddressSchema.parse(address);
  assert.ok(stored.resource_identity.length, "An address names its resource.");
  assert.notEqual(stored, address, "The stored form is a copy.");
  return stored;
}

export function decodeAddress(stored: unknown): PlatformAddress {
  assert.ok(isObject(stored), "A stored address is an object.");
  const address = platformAddressSchema.parse(stored);
  assert.ok(address.resource_identity.length, "An address names its resource.");
  return address;
}

export const addressCodec: ResultCodec = {
  encode: (value) => encodeAddress(platformAddressSchema.parse(value)),
  decode: (stored) => decodeAddress(stored),
};
