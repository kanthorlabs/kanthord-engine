import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  decodeX25519Key,
  generateX25519KeyPair,
  hpkeSuite,
  keyFingerprint,
  openBytes,
  openJSON,
  sealJSON,
  SealedOpenError,
  SEALED_ALGORITHM,
} from "./hpke.ts";

const hex = (value: string) => Buffer.from(value, "hex");
const A1 = {
  info: hex("4f6465206f6e2061204772656369616e2055726e"),
  ikmE: hex("7268600d403fce431561aef583ee1613527cff655c1343f29812e66706df3234"),
  pkEm: hex("37fda3567bdbd628e88668c3c8d7e97d1d1253b6d4ea6d44c150f741f1bf4431"),
  skEm: hex("52c4a758a802cd8b936eceea314432798d5baf2d7e9235dc084ab1b9cfa2f736"),
  ikmR: hex("6db9df30aa07dd42ee5e8181afdb977e538f5e1fec8a06223f33f7013e525037"),
  pkRm: hex("3948cfe0ad1ddb695d780e59077195da6c56506b027329794ab02bca80815c4d"),
  skRm: hex("4612c550263fc8ad58375df3f557aac531d26850903e55a9f23f21d8534e8ac8"),
  pt: hex("4265617574792069732074727574682c20747275746820626561757479"),
  aad: hex("436f756e742d30"),
  ct: hex(
    "f938558b5d72f1a23810b4be2ab4f84331acc02fc97babc53a52ae8218a355a96d8770ac83d07bea87e13c512a",
  ),
};

test("the suite derives the RFC 9180 A.1.1 key pairs", async () => {
  const recipient = await hpkeSuite.kem.deriveKeyPair(A1.ikmR);
  const ephemeral = await hpkeSuite.kem.deriveKeyPair(A1.ikmE);
  assert.deepEqual(
    Buffer.from(await hpkeSuite.kem.serializePublicKey(recipient.publicKey)),
    A1.pkRm,
  );
  assert.deepEqual(
    Buffer.from(await hpkeSuite.kem.serializePrivateKey(recipient.privateKey)),
    A1.skRm,
  );
  assert.deepEqual(
    Buffer.from(await hpkeSuite.kem.serializePublicKey(ephemeral.publicKey)),
    A1.pkEm,
  );
  assert.deepEqual(
    Buffer.from(await hpkeSuite.kem.serializePrivateKey(ephemeral.privateKey)),
    A1.skEm,
  );
});

test("the suite seals the RFC 9180 A.1.1 encryption of sequence 0", async () => {
  const sealed = await hpkeSuite.seal(
    {
      recipientPublicKey: await hpkeSuite.kem.deserializePublicKey(A1.pkRm),
      info: A1.info,
      ekm: await hpkeSuite.kem.deriveKeyPair(A1.ikmE),
    },
    A1.pt,
    A1.aad,
  );
  assert.deepEqual(Buffer.from(sealed.enc), A1.pkEm);
  assert.deepEqual(Buffer.from(sealed.ct), A1.ct);
});

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

test("the fingerprint is the unpadded base64 SHA-256 of the key bytes", async () => {
  const pair = await generateX25519KeyPair();
  const expected = createHash("sha256")
    .update(pair.public_key)
    .digest("base64")
    .replace(/=+$/, "");
  assert.equal(keyFingerprint(pair.public_key), `SHA256:${expected}`);
  assert.doesNotMatch(keyFingerprint(pair.public_key), /=/);
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
