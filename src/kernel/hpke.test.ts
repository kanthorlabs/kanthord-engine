import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeX25519Key,
  generateX25519KeyPair,
  openBytes,
  openJSON,
  SEALED_ALGORITHM,
  SealedOpenError,
  sealJSON,
} from "./hpke.ts";

const hex = (value: string) => Buffer.from(value, "hex");
const A1 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  pkEm: hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"),
  skRm: hex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"),
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: hex(
    "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
  ),
};

test("openBytes opens the RFC 9180 A.1.1 ciphertext with the recipient key", async () => {
  const plaintext = await openBytes(
    A1.skRm,
    A1.info.toString("utf8"),
    A1.aad.toString("utf8"),
    {
      alg: SEALED_ALGORITHM,
      enc: A1.pkEm.toString("base64url"),
      ciphertext: A1.ct.toString("base64url"),
    },
  );
  assert.deepEqual(plaintext, A1.pt);
});

test("a sealed JSON value opens only with its key, info and aad", async () => {
  const pair = await generateX25519KeyPair();
  const other = await generateX25519KeyPair();
  const value = { token: "value", count: 2 };
  const sealed = await sealJSON(pair.public_key, "info/v1", "aad", value);
  assert.equal(sealed.alg, SEALED_ALGORITHM);
  assert.deepEqual(
    await openJSON(pair.private_key, "info/v1", "aad", sealed),
    value,
  );
  for (const [key, info, aad] of [
    [other.private_key, "info/v1", "aad"],
    [pair.private_key, "info/v2", "aad"],
    [pair.private_key, "info/v1", "other"],
  ] as const)
    await assert.rejects(openJSON(key, info, aad, sealed), SealedOpenError);
});

test("decodeX25519Key accepts only a canonical nonzero 32-byte base64url value", async () => {
  const pair = await generateX25519KeyPair();
  const encoded = pair.public_key.toString("base64url");
  assert.deepEqual(decodeX25519Key(encoded), pair.public_key);
  for (const value of [
    Buffer.alloc(32).toString("base64url"),
    Buffer.alloc(31, 1).toString("base64url"),
    Buffer.alloc(33, 1).toString("base64url"),
    `${encoded}=`,
    pair.public_key.toString("base64"),
    "",
  ])
    assert.equal(decodeX25519Key(value), null);
});
