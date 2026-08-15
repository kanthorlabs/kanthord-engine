import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { NodeCryptoSecret } from "./node-crypto.ts";
import { actorSecretPattern } from "../../domain/actor.ts";

describe("src/services/secret/node-crypto.test", () => {
  it("generate returns a 43-character base64url secret over 100 calls", () => {
    const secret = new NodeCryptoSecret();
    for (let i = 0; i < 100; i += 1) {
      const value = secret.generate();
      assert.equal(value.length, 43);
      assert.equal(actorSecretPattern.test(value), true);
    }
  });

  it("two successive generate calls differ", () => {
    const secret = new NodeCryptoSecret();
    assert.notEqual(secret.generate(), secret.generate());
  });

  it("digest returns a 32-byte array and is deterministic per input", () => {
    const secret = new NodeCryptoSecret();
    const first = secret.digest("abc");
    const second = secret.digest("abc");
    assert.equal(first.length, 32);
    assert.equal(Buffer.compare(Buffer.from(first), Buffer.from(second)), 0);
  });

  it("digest of two different inputs differs", () => {
    const secret = new NodeCryptoSecret();
    assert.notEqual(
      Buffer.compare(
        Buffer.from(secret.digest("a")),
        Buffer.from(secret.digest("b")),
      ),
      0,
    );
  });

  it("matches agrees on equal digests and disagrees on different ones", () => {
    const secret = new NodeCryptoSecret();
    const digestA = secret.digest("a");
    const digestB = secret.digest("b");
    assert.equal(secret.matches(digestA, digestA), true);
    assert.equal(secret.matches(digestA, digestB), false);
  });

  it("matches returns false for a 31-byte expected value without throwing", () => {
    const secret = new NodeCryptoSecret();
    const shortExpected = new Uint8Array(31);
    const presented = secret.digest("a");
    assert.equal(secret.matches(shortExpected, presented), false);
  });

  it("compares in constant time by construction", () => {
    const source = sourceText();
    assert.equal(source.includes("timingSafeEqual("), true);
    assert.equal(source.includes('createHash("sha256")'), true);
  });

  it("never compares expected with presented through an operator or a length-leaking primitive", () => {
    const source = sourceText();
    assert.equal(/expected\s*[=!]==?\s*presented/.test(source), false);
    assert.equal(/presented\s*[=!]==?\s*expected/.test(source), false);
    assert.equal(source.includes("Buffer.compare"), false);
    assert.equal(source.includes("localeCompare"), false);
  });
});

function sourceText(): string {
  return readFileSync(resolve(import.meta.dirname, "./node-crypto.ts"), "utf8");
}
