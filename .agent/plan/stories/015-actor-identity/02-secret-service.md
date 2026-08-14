# Story 2 — The `secret` service capability

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 1 (`actorSecretPattern`).

This story passes the full gate standing alone. **It does not delete `tokensMatch`.** The EPIC's story bullet assigns that deletion here, but `authMiddleware` still calls `tokensMatch` until Story 5 rewrites it, so deleting it here would leave `npm run typecheck` red for two dispatched stories. Story 5 performs the deletion in the same change that removes the last caller.

## Change

- Create `src/services/secret/index.ts`. It declares the interface and holds no implementation and no re-export of one.

  ```ts
  export interface Secret {
    generate(): string;
    digest(secret: string): Uint8Array;
    matches(expected: Uint8Array, presented: Uint8Array): boolean;
  }
  ```

  It imports nothing. It contains no occurrence of the string `implements `, which `src/domain/layout.test.ts:159-175` forbids in every `src/services/*/index.ts`.

- Create `src/services/secret/node-crypto.ts`, exporting `export class NodeCryptoSecret implements Secret`. It imports `randomBytes`, `createHash` and `timingSafeEqual` from `node:crypto`. The constructor takes no argument.
  - `generate()` returns `randomBytes(32).toString("base64url")`. Thirty-two bytes render as exactly 43 base64url characters with no padding, so the result always satisfies `actorSecretPattern` of Story 1.
  - `digest(secret)` returns `createHash("sha256").update(secret, "utf8").digest()`.
  - `matches(expected, presented)` returns `false` when `expected.length !== presented.length`, and otherwise returns `timingSafeEqual(expected, presented)`. The length guard exists because `timingSafeEqual` throws on a length mismatch; every caller in this epic passes two 32-byte digests, so the guard is unreachable in production and present so the method is total.
- Do **not** touch `src/http/server/auth.ts` in this story. Story 5 deletes `tokensMatch` at `:6-10` and its `node:crypto` imports at `:1`, in the same change that rewrites `authMiddleware`.
- `src/domain/layout.test.ts:101-124`: add `"secret"` to the service-directory array between `"plan"` and `"storage"`, and change the `it(...)` title at `:101` from `src/services/ holds exactly the fourteen capabilities plus home-lock` to `src/services/ holds exactly the fifteen capabilities plus home-lock`. The array holds sixteen entries after the edit.

## Constraints

- `services/crypto` is not extended and not edited. `Crypto` at `src/services/crypto/index.ts:20-22` exposes `seal` and `open` only, and it is envelope encryption for a stored provider credential. One capability holds one responsibility.
- A fast hash is correct here. The secret is 256 random bits, not a password, so no key-derivation dependency enters. Add no `argon2`, no `bcrypt` and no `scrypt`.
- `src/services/secret/node-crypto.ts` may import `node:crypto`; `eslint.config.js:208-229` bans only `node:child_process` outside `src/services/git/launcher.ts`. `src/services/secret/index.ts` must import nothing at all.
- The new capability needs no `not-implemented.ts`. `src/domain/layout.test.ts:144-157` requires one for `agent`, `verify` and `lease` only.
- Add nothing to `src/main.ts` in this story. Story 5 constructs `NodeCryptoSecret`.

## Verify

- Create `src/services/secret/node-crypto.test.ts`, suite name `src/services/secret/node-crypto.test`, asserting:
  - `generate()` returns a 43-character string matching `actorSecretPattern` from `src/domain/actor.ts`, asserted over 100 successive calls.
  - Two successive `generate()` calls differ.
  - `digest("abc")` returns a `Uint8Array` of length 32, and it equals the digest of a second call on the same input, byte for byte through `Buffer.compare`.
  - `digest` of two different inputs differs.
  - `matches(digest(s), digest(s))` is `true`; `matches(digest("a"), digest("b"))` is `false`.
  - `matches` returns `false` for a 31-byte expected value against a 32-byte presented value, and it does **not** throw.
  - **The constant-time assertion, in the substance of `src/http/server/auth.test.ts:64-76`.** Read the source of `src/services/secret/node-crypto.ts` with `readFileSync` and assert it contains `timingSafeEqual(` and `createHash("sha256")`, and that it never compares `expected` with `presented` through `==`, `===`, `!=`, `!==`, `Buffer.compare` or `localeCompare`.
- Leave `src/http/server/auth.test.ts` untouched. Its `tokensMatch` cases still pass, because `tokensMatch` still exists. Story 5 deletes both together.
- Run `node --test --test-timeout=60000 src/services/secret/node-crypto.test.ts src/domain/layout.test.ts`; each exits 0.
- `npm run verify` exits 0. This story stands alone.
- Proof: `PASS EPIC-015`, and the `timingSafeEqual`-by-construction clause of Hermetic coverage line 112.
