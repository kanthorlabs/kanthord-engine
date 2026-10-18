import assert from "node:assert/strict";
import { ulid } from "ulid";
import { z } from "zod";

const EMPTY_PREFIX_LENGTH = 0;
export const ULID_LENGTH = 26;
export const IDENTITY_SUFFIX_LENGTH = ULID_LENGTH + 1;

const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/** Bare ULIDs are reserved for contracts such as client idempotency keys. */
export const ulidSchema = z.string().length(ULID_LENGTH).regex(ulidPattern);

function buildIdentitySchema(prefix: string) {
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

const identitySchemas = new Map<
  string,
  ReturnType<typeof buildIdentitySchema>
>();

/** The owning service declares a stable, singular prefix for each entity kind. */
export function identitySchema(prefix: string) {
  const cached = identitySchemas.get(prefix);
  if (cached !== undefined) {
    return cached;
  }
  const schema = buildIdentitySchema(prefix);
  identitySchemas.set(prefix, schema);
  return schema;
}

export function createIdentity(prefix: string): string {
  const schema = identitySchema(prefix);
  const suffix = ulid();
  assert.ok(ulidSchema.safeParse(suffix).success, "Invalid generated ULID.");
  const value = `${prefix}_${suffix}`;
  assert.ok(schema.safeParse(value).success, "Invalid generated identity.");
  return value;
}
