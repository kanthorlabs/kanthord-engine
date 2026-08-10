# Story 8 — Composition and provider refusals

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Depends on: coupled Stories 4 through 7.

## Change

- In `src/http/server/credential/refusals.ts:1-18`, import the three new command errors and map each by class and refusal.
- Map every not-found refusal to `httpError("not-found", message)`; map remove binding-in-use to `httpError("binding-in-use", message, { blockers })`.
- Map name-taken and kind-not-chainable to invalid-request with `{ refusal }`; map default-already-set to invalid-request with `{ refusal, ids }`.
- Keep PayloadError mapping unchanged and rethrow unknown errors.
- In `src/main.ts:41-69`, import the three commands and handlers.
- In the handler map beside `provider.register` at `src/main.ts:225-235`, bind rename and setDefault with storage, crypto, clock and events; bind remove with storage and events; pass `settings.actor` to all three handlers.
- In `src/main.test.ts:44-123`, add fixtures for all three operation ids using missing provider ids, a rename body `{ name: "renamed" }`, and expected 404; keep fixture bytewise parity with routed operations.
- Remove the obsolete setDefault 501 test at `src/http/server/credential/register-provider.test.ts:170-202`.

## Constraints

- `toHttpError` accepts the thrown error only; pass no row, payload, ciphertext or plaintext into it.
- Keep `bindingOffenders` empty and `unimplementedFor` empty for the composed map.
- Do not add a CLI command.

## Verify

- Add `src/http/server/credential/refusals.test.ts` covering every new refusal and unknown-error rethrow with exact HTTP code and details.
- In each command test, assert own enumerable error keys are `["name", "refusal"]`, `["ids", "name", "refusal"]` only for default-already-set, or `["blockers", "name", "refusal"]` only for binding-in-use.
- Extend all four provider write handler success tests to parse their body with the operation response schema and assert exact sorted keys; assert each strict schema rejects the same body plus `credential: "secret"`.
- Run `node --test src/http/server/credential/*.test.ts src/main.test.ts`; every routed provider operation answers through real Koa and never 501.
- In `src/main.test.ts:207-214`, assert no routed operation remains outside fixtures and pending; with no provider pending entry, this pins the composed `unimplementedFor` provider result to `[]`.
- Assert no provider fixture answers 501 or internal-error.
- Run `npm run verify`; it exits 0 for the completed Stories 4 through 8 unit.
- Proof: EPIC Proof lines 40 and 45, plus Hermetic coverage lines 66-68.
