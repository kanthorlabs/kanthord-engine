import assert from "node:assert/strict";
import { identitySchema } from "../kernel/identity.ts";
import { deriveKey } from "../kernel/json.ts";
import { INBOUND_ID_PREFIX } from "./contract.ts";

const WEBHOOK_SECRET_LABEL_PREFIX = "webhook/";
const WEBHOOK_SECRET_BYTES = 32;
const NO_LENGTH = 0;

export function webhookSecret(masterKey: string, inboundId: string): string {
  assert.ok(
    masterKey.length > NO_LENGTH,
    "webhookSecret requires a master key.",
  );
  assert.ok(
    identitySchema(INBOUND_ID_PREFIX).safeParse(inboundId).success,
    "webhookSecret requires an inbound identity.",
  );
  const key = deriveKey(
    masterKey,
    `${WEBHOOK_SECRET_LABEL_PREFIX}${inboundId}`,
  );
  assert.equal(key.length, WEBHOOK_SECRET_BYTES);
  return key.toString("base64url");
}
