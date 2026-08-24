# Story 4 — `resolveActor`, the one authentication query

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 1, Story 2, Story 3.

This story passes the full gate standing alone: it adds one query that nothing calls yet.

**`resolveActor` is the single resolution path for every actor, the empty-configured-token mode included.** Story 5's middleware therefore needs no second identity dependency, and identity policy lives in exactly one file.

## Change

- Create `src/queries/actor/resolve-actor.ts`. It imports `domain/` and the two service interfaces `src/services/storage/index.ts` and `src/services/secret/index.ts`, and nothing else. It imports no vendor package.

  ```ts
  export type ResolveActorDependencies = Readonly<{
    storage: Storage;
    secret: Secret;
    configuredToken: string;
  }>;

  export type ResolveActorInput = Readonly<{ presented: string }>;

  export function resolveActor(
    dependencies: ResolveActorDependencies,
    input: ResolveActorInput,
  ): ActorRow | null;
  ```

- The body runs these steps in this exact order. 0. **The empty-configured-token mode resolves the bootstrap actor.** When `dependencies.configuredToken === ""`, load the row whose `id` equals `bootstrapActorId` and return it, **regardless of `input.presented`**. `src/http/server/auth.ts:39` trusts every caller in that mode today, and this step preserves that behaviour with one resolver rather than two. Registration is separately refused in that mode by Story 10, which is what closes the credential-persistence hole. The bootstrap row can never be revoked (Story 10 refuses it), so this step needs no revocation check.
  1. **Configured-token comparison first.** When `dependencies.configuredToken !== ""`, compute `secret.digest(dependencies.configuredToken)` and `secret.digest(input.presented)` and call `secret.matches` over the two. On a match, load the row whose `id` equals `bootstrapActorId` and return it. Compare the **whole** presented value, before any parse. This is what lets a configured token that contains a `.` keep working.
  2. Only when step 1 does not match, run `parseActorToken(input.presented)` from `src/domain/actor.ts`. A `null` result returns `null`.
  3. Load the actor row by the parsed `actorId`. When no row exists, call `secret.matches(dummyDigest, secret.digest(parsed.secret))` where `dummyDigest` is a module-level `new Uint8Array(32)`, discard the result, and return `null`. The call is not optimised away: assign its result to a variable the function then returns as `null` through an explicit `if`, so the unknown-id path and the wrong-secret path each perform exactly one `matches` call.
  4. When the row exists and `row.revokedAt !== null`, return `null`. Perform the `matches` call **before** the revocation check, so a revoked id and a live id do the same work.
  5. When `row.tokenSha256 === null`, return `null`. The bootstrap row is reachable through step 1 only, and it persists no digest.
  6. Return the row when `secret.matches(row.tokenSha256, secret.digest(parsed.secret))` is `true`, and `null` otherwise.
- Every read runs inside one `dependencies.storage.transact(...)` call, following `src/queries/provider/show-provider.ts`. Parse the loaded row through `actorRow` and return the parsed value, so the caller receives an `ActorRow`.

## Constraints

- The dispatch order is contract. `src/services/config/convict.ts:161` accepts the configured token as an unrestricted `String`, so a configured token holding a `.` is legal today, and a parse-first rule breaks that deployment.
- Return `null` for every failure. Throw nothing. An unrecognized shape, an unknown id, a revoked row, a bootstrap row reached by parse, and a wrong secret are all one answer, so the caller cannot distinguish them and neither can a client.
- `queries/` may not import `src/http/server/` or any vendor package. `eslint.config.js:250-274` also bans `node:sqlite` and `node:fs` here, so every read goes through the `Storage` interface.
- Do not add a revocation recheck anywhere else. Revocation is linearized at authentication, and a command does not recheck actor activity inside its transaction.
- Add no caching. The query runs once per request.

## Verify

- Create `src/queries/actor/resolve-actor.test.ts`, suite name `src/queries/actor/resolve-actor.test`. Use **real SQLite** through `createMigratedStorage()` from `test/helpers/database.ts`, the same convention as `src/queries/provider/show-provider.test.ts`. Use the real `NodeCryptoSecret` for the behaviour cases, and a **counting Mock** wrapping it for the call-count cases: the Mock implements `Secret`, delegates to `NodeCryptoSecret`, and records every `matches` call with its two arguments. Seed actor rows by direct `INSERT` inside `storage.transact`, because Story 10 has not written `registerActor` yet.
  - A presented value equal to a non-empty `configuredToken` resolves the bootstrap row: the result's `id` equals `bootstrapActorId` and its `kind` is `"human"`.
  - **A configured token that contains a `.`** — for instance `"abc.def"` — also resolves the bootstrap row. This is the compatibility case the dispatch order exists for.
  - A configured token that is a well-formed actor token string still resolves the bootstrap row, because step 1 precedes the parse.
  - **With `configuredToken: ""`, every presented value resolves the bootstrap row** — a registered harness token, an empty string, and a malformed value all return the bootstrap row. This pins step 0 and is the behaviour `src/http/server/auth.ts:39` has today. Assert `secret.matches` recorded zero calls in this mode.
  - A registered, non-revoked actor's token resolves that row, with `id`, `kind` and `name` asserted equal to the seeded row.
  - A token whose secret is wrong for a real id returns `null`.
  - A token whose actor id is well formed but absent returns `null`, and the Mock recorded **exactly one** `matches` call whose first argument is a 32-byte all-zero `Uint8Array`, asserted through `Buffer.compare` against `new Uint8Array(32)`.
  - A token for a **revoked** actor returns `null`, and the Mock recorded exactly one `matches` call whose first argument is the stored digest — proving the compare runs before the revocation check.
  - The unknown-id case and the wrong-secret case each record exactly one `matches` call, asserted as equal counts.
  - A presented value with no `.`, one whose prefix is `provider_`, one whose secret is 42 characters, and the empty string each return `null`.
  - The bootstrap actor id presented as `bootstrapActorId + "." + <43 chars>` returns `null` under a **non-empty** `configuredToken`, because the bootstrap row stores no digest and step 5 refuses it.
  - `resolveActor` does not throw for any of the rejection inputs above, asserted with `assert.doesNotThrow`.
- Run `node --test --test-timeout=60000 src/queries/actor/resolve-actor.test.ts`; it exits 0.
- `npm run verify` exits 0. This story stands alone.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 111, the authentication clause of 112, and 113.
