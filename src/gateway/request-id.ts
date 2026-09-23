import assert from "node:assert/strict";
import { createIdentity, identitySchema } from "../shared/identity.ts";

export const requestIdSchema = identitySchema("request");

/** Invalid correlation IDs are replaced, never forwarded or logged. */
export function resolveRequestId(value?: string): string {
  const parsed = requestIdSchema.safeParse(value);
  const result = parsed.success ? parsed.data : createIdentity("request");
  assert.ok(requestIdSchema.safeParse(result).success);
  assert.ok(
    !parsed.success || result === value,
    "A valid request ID is retained.",
  );
  return result;
}
