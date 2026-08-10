# Story 10 — Inherited crypto and projection regressions

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Depends on: Story 3.

## Change

- In `src/services/crypto/aes-gcm.test.ts:156-222`, prefix the existing flipped-ciphertext, flipped-tag, flipped-IV, wrong-key and foreign-key-version test names with `regression:`; change no assertion or production code.
- In `src/queries/provider/list-provider.test.ts:191-240`, prefix the broken-payload and named-column test names with `regression:`.
- Strengthen the list named-column test to assert the exact column literal from `src/queries/provider/list-provider.ts:49-50` and reject `SELECT *` case-insensitively.
- In `src/queries/provider/show-provider.test.ts:128-159`, prefix the broken-payload test name with `regression:`.
- Add a show named-column regression that reads `src/queries/provider/show-provider.ts`, asserts the same exact nine-column literal and rejects `SELECT *` case-insensitively.

## Constraints

- Change no file under `src/services/crypto/` except its test.
- Change no provider query production file.
- Keep all tests hermetic; use existing fixed crypto values and temporary SQLite helpers.

## Verify

- Run `node --test src/services/crypto/aes-gcm.test.ts src/queries/provider/list-provider.test.ts src/queries/provider/show-provider.test.ts`; it exits 0.
- Confirm the crypto suite still asserts authentication failure for changed ciphertext, tag, IV and key, plus crypto-key-missing for a foreign version.
- Confirm each query retains a broken row and returns `projection: null`.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 39, 45 and the inherited regression marker at EPIC line 29.
