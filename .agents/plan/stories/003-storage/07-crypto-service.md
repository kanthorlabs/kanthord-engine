# Story 07 — Crypto service

Epic: `.agents/plan/epics/003-storage.md`
Depends on: EPIC 002 Story 11 (`src/services/crypto/index.ts`).

## Change

### 1. `src/services/crypto/aes-gcm.ts` (new)

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { Crypto, SealedPayload } from "./index.ts";
import { CryptoError } from "./index.ts";

export type AesGcmCryptoDependencies = Readonly<{
  key: Uint8Array;
  keyVersion: number;
  randomBytes?: (size: number) => Uint8Array;
}>;

export class AesGcmCrypto implements Crypto {
  constructor(dependencies: AesGcmCryptoDependencies);
  seal(plaintext: string): SealedPayload;
  open(sealed: SealedPayload): string;
}
```

Exact behaviour.

- The constructor throws a `CryptoError` of code `crypto-key-missing` when `key.length !== 32`, with the message `the master key must be 32 bytes, got <length>`. It then stores **a copy** — `this.key = new Uint8Array(dependencies.key)` — so a caller that mutates its own buffer afterwards cannot change the effective master key. It stores `keyVersion`, and `dependencies.randomBytes ?? ((size) => new Uint8Array(randomBytes(size)))`.
- `private freshIv()` — calls the random source with `12`, then throws a plain `Error` with the message `the random source returned <length> bytes, expected 12` unless the result is a `Uint8Array` of length 12. A plain `Error`, not a `CryptoError`: the two codes of the fixed interface are `crypto-key-missing` and `crypto-authentication-failed`, and a broken random source is neither — it is a programming error in the composition root. Without the check, an injected source could produce an IV the `provider` `CHECK` clause then refuses at insert time, a phase away from its cause.
- `seal(plaintext)`:
  1. `const iv = this.freshIv();`
  2. `const cipher = createCipheriv("aes-256-gcm", this.key, iv);`
  3. `cipher.setAAD(Buffer.from(String(this.keyVersion), "utf8"));`
  4. `ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])`
  5. `tag = cipher.getAuthTag()`
  6. returns `{ ciphertext: new Uint8Array(ciphertext), iv: new Uint8Array(iv), tag: new Uint8Array(tag), keyVersion: this.keyVersion }`. The `iv` field is a **copy**, so the returned payload never aliases the random source's buffer.
- `open(sealed)`:
  1. `sealed.keyVersion !== this.keyVersion` throws a `CryptoError` of code `crypto-key-missing`, with the message `no master key of version <keyVersion>`. This is checked first, and nothing calls into `node:crypto` before it.
  2. `createDecipheriv("aes-256-gcm", this.key, sealed.iv)`, `setAAD(Buffer.from(String(this.keyVersion), "utf8"))`, `setAuthTag(sealed.tag)`, `update` then `final`, decoded as `utf8`.
  3. Any throw from step 2 becomes `new CryptoError("crypto-authentication-failed", "the sealed payload failed authentication")`. The original error is not re-exposed, because its message names the cipher state.

**`keyVersion` is bound as GCM additional authenticated data.** It selects the key on the read path, and it sits in its own `provider` column outside the ciphertext. Binding it means a payload whose `key_version` was edited fails authentication instead of silently selecting a different key. The AAD does not change the ciphertext bytes; it changes the tag.

Every **binary** field of the returned payload is a plain `Uint8Array`, never a `Buffer` — `keyVersion` is a number. A `Buffer` compares unequal to a `Uint8Array` under `assert.deepEqual`, and the three binary fields cross the `provider` row boundary.

## Constraints

- The key never appears in a message, a log line or an error.
- The IV is 12 bytes and the tag is 16 bytes, which the `provider` `CHECK` clauses of `docs/proposal/database/provider.md:16-17` enforce at the database level.
- No key rotation, no re-encryption, no key derivation. One key, one version, injected. `open` refusing a foreign `keyVersion` is what makes rotation an added key rather than a schema change.
- `src/services/crypto/index.ts` is not modified. No other capability is touched, and no row is written here — `provider` writes arrive with their command.

## Verify

`node --test src/services/crypto/aes-gcm.test.ts` — new file, one suite named `"src/services/crypto/aes-gcm.test"`.

Fixtures at the top of the file:

```ts
const key = new Uint8Array(32).fill(7);
const ivA = new Uint8Array(12).fill(1);
const ivB = new Uint8Array(12).fill(2);
const plaintext = JSON.stringify({
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
});
const pinned = new AesGcmCrypto({ key, keyVersion: 1, randomBytes: () => ivA });
```

- Exact bytes, with `keyVersion` bound as AAD. `pinned.seal(plaintext)` returns:
  - `ciphertext` whose hex is exactly
    `0dc3efd8e2d8892cebf6bb48045f05538ad736816bf2497d395c26405c965ddaacc660dfee77a8e231066a27e30a81f2eb75cb387fd9972ffd3a8575`,
  - `tag` whose hex is exactly `76fda6d54d3a5f04dd4d42cc509579cd`,
  - `iv` byte-equal to `ivA`,
  - `keyVersion === 1`.
- `ciphertext.length === 60`, `iv.length === 12`, `tag.length === 16`.
- Each of `ciphertext`, `iv` and `tag` has `Uint8Array.prototype` as its prototype — `Object.getPrototypeOf(value) === Uint8Array.prototype`, which a `Buffer` fails. `typeof sealed.keyVersion === "number"`.
- No aliasing: `sealed.iv !== ivA` by reference, and mutating `ivA` after the call leaves `sealed.iv` unchanged.
- The key is copied on ingress: build a crypto over a mutable `new Uint8Array(32).fill(7)`, seal, then fill that same array with `0`, then seal again. The two ciphertexts are identical, so the mutation did not reach the cipher.
- Round trip: `pinned.open(pinned.seal(plaintext)) === plaintext`. A second case round-trips the empty string, and a third round-trips `"clé-ünïcode-✓"`.
- A fresh IV per record, asserted deterministically. A crypto whose random source returns `ivA` then `ivB` from a two-entry queue: two seals of the same plaintext consume one entry each — the queue is empty afterwards — the two `iv` values differ, the two `ciphertext` values differ, both round-trip, and each call asked for size `12` (recorded by the injected function). No case asserts that two calls of the real `randomBytes` differ; a real-source case asserts only `iv.length === 12` and a round trip.
- A bad random source: `randomBytes: () => new Uint8Array(11)` makes `seal` throw a plain `Error` with message `"the random source returned 11 bytes, expected 12"`, and the thrown error is not a `CryptoError`.
- Tampering: take the pinned sealed payload and flip the last byte of `ciphertext`. `open` throws with `error instanceof CryptoError`, `error.name === "CryptoError"`, `error.code === "crypto-authentication-failed"` and `error.message === "the sealed payload failed authentication"`. Repeat for a flipped byte of `tag` and a flipped byte of `iv` — all three throw the same code.
- The AAD binds `keyVersion`: a crypto with the same key and `keyVersion: 2` opening a payload whose `keyVersion` field was rewritten to `2` throws `"crypto-authentication-failed"`. Without the AAD the tag would verify and the payload would open under the wrong key generation.
- A wrong key: a second crypto with `new Uint8Array(32).fill(8)` and `keyVersion: 1` throws `"crypto-authentication-failed"` on the pinned payload.
- Version mismatch, and the ordering of the two checks: `pinned.open({ ...sealed, keyVersion: 2 })` throws with `code === "crypto-key-missing"` and message `"no master key of version 2"`. A second case passes `{ keyVersion: 2, iv: new Uint8Array(3), tag: new Uint8Array(1), ciphertext: new Uint8Array(0) }` — data `createDecipheriv` would reject outright — and still gets `crypto-key-missing`, which is the observable proof that the version check runs before any crypto call.
- Key length: `new AesGcmCrypto({ key: new Uint8Array(16), keyVersion: 1 })` throws with `code === "crypto-key-missing"` and message `"the master key must be 32 bytes, got 16"`. A 33-byte key throws the same code.

`npm run verify` exits 0.

Proof: covered by `npm run verify`. This story adds no file under `src/services/storage/`.
