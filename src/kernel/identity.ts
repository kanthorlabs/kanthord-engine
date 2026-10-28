import assert from "node:assert/strict";
import { decodeTime, ulid } from "ulid";
import { z } from "zod";

const EMPTY_PREFIX_LENGTH = 0;
export const ULID_LENGTH = 26;
export const IDENTITY_SUFFIX_LENGTH = ULID_LENGTH + 1;

const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const ulidSchema = z.string().length(ULID_LENGTH).regex(ulidPattern);

export function identitySchema(prefix: string) {
  assert.ok(
    prefix.length > EMPTY_PREFIX_LENGTH,
    "An identity requires an entity prefix.",
  );
  assert.match(
    prefix,
    /^[a-z]+(?:_[a-z]+)*(?![\s\S])/,
    "An entity prefix uses lower-case words separated by single underscores.",
  );
  return z
    .string()
    .length(prefix.length + IDENTITY_SUFFIX_LENGTH)
    .regex(new RegExp(`^${prefix}_[0-7][0-9A-HJKMNP-TV-Z]{25}$`))
    .describe(
      `${prefix}_ followed by a canonical 26-character uppercase ULID.`,
    );
}

export function createIdentity(prefix: string): string {
  const schema = identitySchema(prefix);
  const suffix = ulid();
  assert.ok(ulidSchema.safeParse(suffix).success, "Invalid generated ULID.");
  const value = `${prefix}_${suffix}`;
  assert.ok(schema.safeParse(value).success, "Invalid generated identity.");
  return value;
}

export function identityTime(identity: string): number {
  const suffix = identity.slice(identity.lastIndexOf("_") + 1);
  assert.ok(
    ulidSchema.safeParse(suffix).success,
    "An identity requires a ULID suffix.",
  );
  return decodeTime(suffix);
}

export const IDEMPOTENCY_KEY_PREFIX = "idempotency_key";

export const idempotencyKeySchema = identitySchema(IDEMPOTENCY_KEY_PREFIX);

export function createIdempotencyKey(): string {
  return createIdentity(IDEMPOTENCY_KEY_PREFIX);
}
