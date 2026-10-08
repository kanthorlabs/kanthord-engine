import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { deriveKey } from "../kernel/json.ts";
import { webhookSecret } from "./webhook-secret.ts";

const KEY_BYTES = 32;
const RECORD_CIPHER_LABEL = "custody/aes-256-gcm/v1";
const JWT_SIGNING_LABEL = "gateway/jwt-hs256/v1";
const INBOUND = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_INBOUND = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAW";

function masterKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

test("a webhook secret is HKDF-SHA256 of the master key with the webhook label in base64url", () => {
  const key = masterKey();
  const expected = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(key, "base64"),
      Buffer.alloc(0),
      `webhook/${INBOUND}`,
      KEY_BYTES,
    ),
  ).toString("base64url");
  assert.equal(webhookSecret(key, INBOUND), expected);
  assert.equal(Buffer.from(expected, "base64url").length, KEY_BYTES);
});

test("two inbound identities answer two secrets", () => {
  const key = masterKey();
  assert.notEqual(
    webhookSecret(key, INBOUND),
    webhookSecret(key, OTHER_INBOUND),
  );
});

test("one inbound identity answers one secret on every call", () => {
  const key = masterKey();
  assert.equal(webhookSecret(key, INBOUND), webhookSecret(key, INBOUND));
});

test("a replaced master key answers a different secret", () => {
  assert.notEqual(
    webhookSecret(masterKey(), INBOUND),
    webhookSecret(masterKey(), INBOUND),
  );
});

test("the secret differs from the record cipher key and the JWT signing key", () => {
  const key = masterKey();
  const secret = Buffer.from(webhookSecret(key, INBOUND), "base64url");
  assert.ok(!secret.equals(deriveKey(key, RECORD_CIPHER_LABEL)));
  assert.ok(!secret.equals(deriveKey(key, JWT_SIGNING_LABEL)));
});
