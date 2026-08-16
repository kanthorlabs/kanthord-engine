# Story 7 — the refusal map shrinks

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 5. Coupled with Stories 5 and 6; this story closes the unit and runs the gate.

This story changes the credential refusal map only. The `ids` half of D8 moved to Story 10, which narrows `ids` to a `plan.import`-specific schema instead of deleting it. Story 10 still needs an EPIC amendment before it runs; this story does not.

## Change — the refusal map

- Delete lines 24-29 of `src/http/server/credential/refusals.ts`, the whole `if (error.refusal === "default-already-set") { … }` branch. The `SetDefaultProviderError` arm then reads: `not-found` maps to `httpError("not-found", error.message)`, and every other refusal maps to `httpError("invalid-request", error.message, { refusal: error.refusal })`. Change no other arm of `toHttpError`.
- Delete the `default-already-set` case at `src/http/server/credential/refusals.test.ts:48-60` and the `default-already-set` case at `src/http/server/credential/set-default-provider.test.ts:106-118`. Replace the second with a case asserting a `kind-not-chainable` refusal answers `400` and that `response.body.error.details` deep-equals `{ refusal: "kind-not-chainable" }`, with no `ids` key.

## `ids` is not deleted here

Do not touch `src/http/contract/error-details.ts` in this story.

D8 claims `src/http/server/credential/refusals.ts:27` is the only producer of `ids`. It is not: `src/http/server/plan/refusals.ts:33-36` emits `ids` for the `choice-duplicate`, `choice-missing` and `choice-extra` refusals of `importPlan`, and `src/http/contract/error-baseline.ts:5` puts `invalidRequestDetails` on all 62 operations. Deleting the field outright would make the daemon emit plan-choice details its own published contract refuses.

Story 10 resolves it by narrowing rather than deleting: the baseline drops `ids`, and `plan.import` gains its own details schema that keeps it. Run this story now; run Story 10 after the EPIC amendment it names.

## Constraints

- This story alone is a complete, gateable change. It does not depend on Story 10.
- Do not delete, narrow or re-shape `invalidRequestDetails` in any way in this story.
- Do not change `src/http/server/plan/refusals.ts`. It is outside this epic.
- Do not change the `PayloadError`, `RegisterProviderError`, `RenameProviderError` or `RemoveProviderError` arms of `toHttpError`.
- The field-decisions walk covers the query, request and response slots only, so no `error-details.ts` edit would move a fixture row in any case. Story 2 already regenerated the fixture for the payload union.

## Verify

- Add to `src/http/server/credential/refusals.test.ts` a test named `"no credential refusal emits ids"` asserting that `toHttpError(new SetDefaultProviderError("kind-not-chainable", "m")).details` deep-equals `{ refusal: "kind-not-chainable" }`, and that the text of `src/http/server/credential/refusals.ts`, read through `readFileSync`, contains no occurrence of `ids`. Scope the file scan to the credential directory. A scan over all of `src/http/server/` fails on the live plan producer.
- Run `node --test --test-timeout=60000 src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/http/contract/error-details.test.ts src/http/server/plan/refusals.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts scripts/publish-contract.test.ts`; it exits 0. The two plan test files are the regression guard that this story left `invalidRequestDetails` alone.
- Run `grep -rn "default-already-set" src/`; it returns nothing.
- Run `npm run verify`; it exits 0. This is the gate that closes the coupled unit of Stories 5, 6 and 7.
- Proof: `PASS EPIC-021` for `src/http/server/credential/*.test.ts`. Hermetic coverage "The transfer" bullet 10 is delivered **in part**: the `Object.keys(error).sort()` clause comes from Story 5, and this story adds the credential-scoped `grep` clause. Story 10 delivers the `invalidRequestDetails.safeParse({ refusal: "x", ids: [] })` clause.
