import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  buildAad,
  decrypt,
  deriveEnvelopeKey,
  encrypt,
  NONCE_BYTES,
  TAG_BYTES,
} from "./envelope.ts";

const key = deriveEnvelopeKey(randomBytes(32).toString("base64"));
const id = "credential-1";
const platform = "github";
const secret = { key: "secret-value" };

for (const [shape, value] of Object.entries({
  api_key: { key: "secret-value" },
  oauth: { refresh: "refresh-token", access: "access-token", expires: 12345 },
  s3_access_key: {
    access_key_id: "access-key-id",
    secret_access_key: "secret-access-key",
  },
})) {
  test(`${shape} secret round-trips`, () => {
    const { nonce, ciphertext } = encrypt(key, id, platform, value);
    assert.equal(nonce.length, NONCE_BYTES);
    assert.deepEqual(decrypt(key, id, platform, nonce, ciphertext), value);
  });
}

test("wrong id fails authentication", () => {
  const { nonce, ciphertext } = encrypt(key, id, platform, secret);
  assert.throws(() => decrypt(key, "other-id", platform, nonce, ciphertext));
});

test("wrong platform fails authentication", () => {
  const { nonce, ciphertext } = encrypt(key, id, platform, secret);
  assert.throws(() => decrypt(key, id, "other-platform", nonce, ciphertext));
});

test("invalid nonce length is rejected", () => {
  const { nonce, ciphertext } = encrypt(key, id, platform, secret);
  assert.throws(() =>
    decrypt(key, id, platform, nonce.subarray(1), ciphertext),
  );
});

test("ciphertext with only a tag is rejected", () => {
  const { nonce } = encrypt(key, id, platform, secret);
  assert.throws(() =>
    decrypt(key, id, platform, nonce, Buffer.alloc(TAG_BYTES)),
  );
});

test("modified ciphertext fails authentication", () => {
  const { nonce, ciphertext } = encrypt(key, id, platform, secret);
  const modified = Buffer.from(ciphertext);
  modified.writeUInt8(modified.readUInt8(0) ^ 1, 0);
  assert.throws(() => decrypt(key, id, platform, nonce, modified));
});

test("each encryption uses a fresh nonce and ciphertext", () => {
  const first = encrypt(key, id, platform, secret);
  const second = encrypt(key, id, platform, secret);
  assert.notDeepEqual(first.nonce, second.nonce);
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
});

test("AAD uses big-endian UTF-8 byte lengths in id-platform order", () => {
  assert.deepEqual(
    buildAad("é", "s3"),
    Buffer.from([0, 0, 0, 2, 0xc3, 0xa9, 0, 0, 0, 2, 0x73, 0x33]),
  );
});
