# Story 1 — Monotonic id generator

Epic: `.agents/plan/epics/101-credential-registry-completion.md`
Depends on: EPIC 100.

## Change

- In `src/services/ids/ulid.ts:1`, replace the `ulid` import with `monotonicFactory` from `ulid`.
- In `src/services/ids/ulid.ts` before `UlidIdGenerator`, create one module-scoped factory named `mintUlid` with `monotonicFactory()`.
- In `UlidIdGenerator.mint` at `src/services/ids/ulid.ts:8-10`, call `mintUlid()` and retain `${identityPrefixes[kind]}_<ULID>` unchanged.
- Share that factory across every `UlidIdGenerator` instance and every `IdentityKind` for the process lifetime.

## Constraints

- Do not change `IdGenerator`, identity prefixes, ULID length or identity parsing.
- Do not create a factory in the class, constructor or `mint` method.

## Verify

- Extend `src/services/ids/ulid.test.ts` with a `node:test` case that mocks `Date.now` to `1700000000000`, mints two `event` ids and asserts `Buffer.compare(Buffer.from(first), Buffer.from(second)) === -1`.
- Keep the existing project format test and every `IdentityKind` parsing test unchanged and green.
- Run `node --test src/services/ids/ulid.test.ts`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 41 and 45, plus Hermetic coverage line 50.
