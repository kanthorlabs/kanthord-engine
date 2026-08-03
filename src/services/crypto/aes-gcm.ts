import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Crypto, SealedPayload } from "./index.ts";
import { CryptoError } from "./index.ts";

export type AesGcmCryptoDependencies = Readonly<{
  key: Uint8Array;
  keyVersion: number;
  randomBytes?: (size: number) => Uint8Array;
}>;

export class AesGcmCrypto implements Crypto {
  readonly #key: Uint8Array;
  readonly #keyVersion: number;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(dependencies: AesGcmCryptoDependencies) {
    if (dependencies.key.length !== 32) {
      throw new CryptoError(
        "crypto-key-missing",
        `the master key must be 32 bytes, got ${dependencies.key.length}`,
      );
    }
    this.#key = new Uint8Array(dependencies.key);
    this.#keyVersion = dependencies.keyVersion;
    this.#randomBytes =
      dependencies.randomBytes ??
      ((size: number): Uint8Array => new Uint8Array(randomBytes(size)));
  }

  seal(plaintext: string): SealedPayload {
    const iv = this.#freshIv();
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(String(this.#keyVersion), "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return {
      ciphertext: new Uint8Array(ciphertext),
      iv: new Uint8Array(iv),
      tag: new Uint8Array(tag),
      keyVersion: this.#keyVersion,
    };
  }

  open(sealed: SealedPayload): string {
    if (sealed.keyVersion !== this.#keyVersion) {
      throw new CryptoError(
        "crypto-key-missing",
        `no master key of version ${sealed.keyVersion}`,
      );
    }
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.iv);
      decipher.setAAD(Buffer.from(String(this.#keyVersion), "utf8"));
      decipher.setAuthTag(sealed.tag);
      return Buffer.concat([
        decipher.update(sealed.ciphertext),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new CryptoError(
        "crypto-authentication-failed",
        "the sealed payload failed authentication",
      );
    }
  }

  #freshIv(): Uint8Array {
    const iv = this.#randomBytes(12);
    if (!(iv instanceof Uint8Array) || iv.length !== 12) {
      throw new Error(
        `the random source returned ${iv instanceof Uint8Array ? iv.length : 0} bytes, expected 12`,
      );
    }
    return iv;
  }
}
