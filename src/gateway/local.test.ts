import assert from "node:assert/strict";
import { hkdfSync, randomBytes } from "node:crypto";
import { test } from "node:test";
import { deriveClientSecret } from "./local.ts";

const TOKEN_VERSION = 1;
const NEXT_TOKEN_VERSION = 2;

const KEY_BYTES = 32;
const SUBJECT = "client_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_SUBJECT = "client_01ARZ3NDEKTSV4RRFFQ69G5FAW";

test("client secrets use HKDF-SHA256 and bind to the master key and machine subject", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const secret = deriveClientSecret(masterKey, TOKEN_VERSION, SUBJECT);
  const expected = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(masterKey, "base64"),
      Buffer.alloc(0),
      `worker/client-secret/v1/${SUBJECT}`,
      KEY_BYTES,
    ),
  ).toString("base64");
  assert.equal(secret, expected);
  assert.equal(deriveClientSecret(masterKey, TOKEN_VERSION, SUBJECT), secret);
  assert.notEqual(
    deriveClientSecret(masterKey, TOKEN_VERSION, OTHER_SUBJECT),
    secret,
  );
  assert.notEqual(
    deriveClientSecret(
      randomBytes(KEY_BYTES).toString("base64"),
      TOKEN_VERSION,
      SUBJECT,
    ),
    secret,
  );
  assert.equal(Buffer.from(secret, "base64").length, KEY_BYTES);
  assert.equal(Buffer.from(secret, "base64").toString("base64"), secret);
});

test("a token version increment changes every client secret", () => {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const next = deriveClientSecret(masterKey, NEXT_TOKEN_VERSION, SUBJECT);
  assert.notEqual(next, deriveClientSecret(masterKey, TOKEN_VERSION, SUBJECT));
  assert.equal(
    next,
    Buffer.from(
      hkdfSync(
        "sha256",
        Buffer.from(masterKey, "base64"),
        Buffer.alloc(0),
        `worker/client-secret/v${NEXT_TOKEN_VERSION}/${SUBJECT}`,
        KEY_BYTES,
      ),
    ).toString("base64"),
  );
});
