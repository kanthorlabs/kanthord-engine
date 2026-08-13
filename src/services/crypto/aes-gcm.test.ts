import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { CryptoError, type SealedPayload } from "./index.ts";
import { AesGcmCrypto } from "./aes-gcm.ts";

const key = new Uint8Array(32).fill(7);
const ivA = new Uint8Array(12).fill(1);
const ivB = new Uint8Array(12).fill(2);
const plaintext = JSON.stringify({
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
});
const pinned = new AesGcmCrypto({ key, keyVersion: 1, randomBytes: () => ivA });

const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

const flippedLastByte = (value: Uint8Array): Uint8Array => {
  const copy = new Uint8Array(value);
  copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 0xff;
  return copy;
};

const assertAuthenticationFailed = (
  crypto: AesGcmCrypto,
  sealed: SealedPayload,
): void => {
  assert.throws(
    () => crypto.open(sealed),
    (error: unknown) =>
      error instanceof CryptoError &&
      error.name === "CryptoError" &&
      error.code === "crypto-authentication-failed" &&
      error.message === "the sealed payload failed authentication",
  );
};

describe("src/services/crypto/aes-gcm.test", () => {
  it("seal produces the exact pinned bytes with keyVersion bound as AAD", () => {
    const sealed = pinned.seal(plaintext);
    assert.equal(
      hex(sealed.ciphertext),
      "0dc3efd8e2d8892cebf6bb48045f05538ad736816bf2497d395c26405c965ddaacc660dfee77a8e231066a27e30a81f2eb75cb387fd9972ffd3a8575",
    );
    assert.equal(hex(sealed.tag), "76fda6d54d3a5f04dd4d42cc509579cd");
    assert.deepEqual(sealed.iv, ivA);
    assert.equal(sealed.keyVersion, 1);
  });

  it("seal produces a 60-byte ciphertext, a 12-byte iv and a 16-byte tag", () => {
    const sealed = pinned.seal(plaintext);
    assert.equal(sealed.ciphertext.length, 60);
    assert.equal(sealed.iv.length, 12);
    assert.equal(sealed.tag.length, 16);
  });

  it("the three binary fields are plain Uint8Array values and keyVersion is a number", () => {
    const sealed = pinned.seal(plaintext);
    assert.equal(
      Object.getPrototypeOf(sealed.ciphertext),
      Uint8Array.prototype,
    );
    assert.equal(Object.getPrototypeOf(sealed.iv), Uint8Array.prototype);
    assert.equal(Object.getPrototypeOf(sealed.tag), Uint8Array.prototype);
    assert.equal(typeof sealed.keyVersion, "number");
  });

  it("the sealed iv does not alias the random source buffer", () => {
    const source = new Uint8Array(12).fill(1);
    const crypto = new AesGcmCrypto({
      key,
      keyVersion: 1,
      randomBytes: () => source,
    });
    const sealed = crypto.seal(plaintext);
    const before = hex(sealed.iv);
    assert.notEqual(sealed.iv, source);
    source.fill(9);
    assert.equal(hex(sealed.iv), before);
  });

  it("the master key is copied on ingress", () => {
    const mutable = new Uint8Array(32).fill(7);
    const crypto = new AesGcmCrypto({
      key: mutable,
      keyVersion: 1,
      randomBytes: () => ivA,
    });
    const first = crypto.seal(plaintext);
    mutable.fill(0);
    const second = crypto.seal(plaintext);
    assert.equal(hex(first.ciphertext), hex(second.ciphertext));
  });

  it("open round-trips the sealed plaintext", () => {
    assert.equal(pinned.open(pinned.seal(plaintext)), plaintext);
  });

  it("open round-trips the empty string", () => {
    assert.equal(pinned.open(pinned.seal("")), "");
  });

  it("open round-trips unicode text", () => {
    assert.equal(pinned.open(pinned.seal("clé-ünïcode-✓")), "clé-ünïcode-✓");
  });

  it("a fresh iv is minted per record and each call asks for 12 bytes", () => {
    const source: Uint8Array[] = [ivA, ivB];
    const requested: number[] = [];
    const crypto = new AesGcmCrypto({
      key,
      keyVersion: 1,
      randomBytes: (size) => {
        requested.push(size);
        const next = source.shift();
        if (next === undefined) {
          throw new Error("random source queue exhausted");
        }
        return next;
      },
    });
    const one = crypto.seal(plaintext);
    const two = crypto.seal(plaintext);
    assert.equal(source.length, 0);
    assert.deepEqual(requested, [12, 12]);
    assert.equal(hex(one.iv), hex(ivA));
    assert.equal(hex(two.iv), hex(ivB));
    assert.notEqual(hex(one.ciphertext), hex(two.ciphertext));
    assert.equal(crypto.open(one), plaintext);
    assert.equal(crypto.open(two), plaintext);
  });

  it("the real random source mints a 12-byte iv and round-trips", () => {
    const crypto = new AesGcmCrypto({ key, keyVersion: 1 });
    const sealed = crypto.seal(plaintext);
    assert.equal(sealed.iv.length, 12);
    assert.equal(crypto.open(sealed), plaintext);
  });

  it("a short random source response throws a plain Error, not a CryptoError", () => {
    const crypto = new AesGcmCrypto({
      key,
      keyVersion: 1,
      randomBytes: () => new Uint8Array(11),
    });
    assert.throws(
      () => crypto.seal(plaintext),
      (error: unknown) =>
        error instanceof Error &&
        !(error instanceof CryptoError) &&
        error.message === "the random source returned 11 bytes, expected 12",
    );
  });

  it("regression: a flipped ciphertext byte fails authentication", () => {
    const sealed = pinned.seal(plaintext);
    assertAuthenticationFailed(pinned, {
      ...sealed,
      ciphertext: flippedLastByte(sealed.ciphertext),
    });
  });

  it("regression: a flipped tag byte fails authentication", () => {
    const sealed = pinned.seal(plaintext);
    assertAuthenticationFailed(pinned, {
      ...sealed,
      tag: flippedLastByte(sealed.tag),
    });
  });

  it("regression: a flipped iv byte fails authentication", () => {
    const sealed = pinned.seal(plaintext);
    assertAuthenticationFailed(pinned, {
      ...sealed,
      iv: flippedLastByte(sealed.iv),
    });
  });

  it("keyVersion is bound as additional authenticated data", () => {
    const cryptoV2 = new AesGcmCrypto({
      key,
      keyVersion: 2,
      randomBytes: () => ivA,
    });
    const sealed = pinned.seal(plaintext);
    assertAuthenticationFailed(cryptoV2, { ...sealed, keyVersion: 2 });
  });

  it("regression: a wrong master key fails authentication", () => {
    const wrongKey = new AesGcmCrypto({
      key: new Uint8Array(32).fill(8),
      keyVersion: 1,
      randomBytes: () => ivA,
    });
    assertAuthenticationFailed(wrongKey, pinned.seal(plaintext));
  });

  it("regression: a foreign keyVersion throws crypto-key-missing with the version message", () => {
    const sealed = pinned.seal(plaintext);
    assert.throws(
      () => pinned.open({ ...sealed, keyVersion: 2 }),
      (error: unknown) =>
        error instanceof CryptoError &&
        error.code === "crypto-key-missing" &&
        error.message === "no master key of version 2",
    );
  });

  it("the version check runs before any crypto call", () => {
    assert.throws(
      () =>
        pinned.open({
          keyVersion: 2,
          iv: new Uint8Array(3),
          tag: new Uint8Array(1),
          ciphertext: new Uint8Array(0),
        }),
      (error: unknown) =>
        error instanceof CryptoError &&
        error.code === "crypto-key-missing" &&
        error.message === "no master key of version 2",
    );
  });

  it("a 16-byte master key is refused at construction", () => {
    assert.throws(
      () => new AesGcmCrypto({ key: new Uint8Array(16), keyVersion: 1 }),
      (error: unknown) =>
        error instanceof CryptoError &&
        error.code === "crypto-key-missing" &&
        error.message === "the master key must be 32 bytes, got 16",
    );
  });

  it("a 33-byte master key is refused at construction", () => {
    assert.throws(
      () => new AesGcmCrypto({ key: new Uint8Array(33), keyVersion: 1 }),
      (error: unknown) =>
        error instanceof CryptoError &&
        error.code === "crypto-key-missing" &&
        error.message === "the master key must be 32 bytes, got 33",
    );
  });
});
