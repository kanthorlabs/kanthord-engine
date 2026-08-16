# Story 7 — the refusal map shrinks

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 5. Coupled with Stories 5 and 6; this story closes the unit and runs the gate.

**Part B of this story is BLOCKED on an EPIC amendment. Do not implement Part B. See "Blocked: D8".**

## Change — Part A, the refusal map (implement this)

- Delete lines 24-29 of `src/http/server/credential/refusals.ts`, the whole `if (error.refusal === "default-already-set") { … }` branch. The `SetDefaultProviderError` arm then reads: `not-found` maps to `httpError("not-found", error.message)`, and every other refusal maps to `httpError("invalid-request", error.message, { refusal: error.refusal })`. Change no other arm of `toHttpError`.
- Delete the `default-already-set` case at `src/http/server/credential/refusals.test.ts:48-60` and the `default-already-set` case at `src/http/server/credential/set-default-provider.test.ts:106-118`. Replace the second with a case asserting a `kind-not-chainable` refusal answers `400` and that `response.body.error.details` deep-equals `{ refusal: "kind-not-chainable" }`, with no `ids` key.

## Blocked: D8, `ids` leaves `invalidRequestDetails`

Do not delete `ids` from `src/http/contract/error-details.ts:79`.

D8 rests on the claim that `src/http/server/credential/refusals.ts:27` is the only producer of `ids`. That claim is false in the current tree:

- `src/http/contract/error-baseline.ts:5` assigns `invalidRequestDetails.optional()` to the shared `invalid-request` code, so the schema is not credential-scoped.
- `src/http/server/plan/refusals.ts:33-36` emits `httpError("invalid-request", error.message, { refusal: error.refusal, ids: details(error).ids })` for the `choice-duplicate`, `choice-missing` and `choice-extra` refusals of `importPlan`. That producer is live, is unrelated to this epic, and survives it.
- `src/http/contract/error-details.test.ts:359-363` asserts `invalidRequestDetails.parse({ refusal: "choice-missing", ids: ["a"] })` succeeds, and `src/http/server/plan/refusals.test.ts:133` asserts the emitted `ids`.

So deleting the field fails `npm run verify` and, worse, makes the daemon emit plan-choice details its own published contract refuses. The EPIC's Hermetic bullet "`grep` over `src/http/server/` finds no `ids:` in a `httpError` details argument" cannot pass while plan choice refusals exist.

Two designs resolve it, and the choice belongs to the EPIC, not to the implementer:

1. Keep `ids` in the shared schema, and drop D8 and its Hermetic bullet. The epic then closes two client findings on the error surface instead of three.
2. Give `plan.import` its own `invalid-request` details schema carrying `ids`, and narrow the baseline schema to `refusal` and `detail`. This adds plan contract, plan server and plan test work that no story of this epic scopes, and it touches the `plan.import` published error shape.

Stop and ask the human before either. Do not pick one at build time.

## Constraints

- Part A alone is a complete, gateable change. It does not depend on Part B.
- Do not delete, narrow or re-shape `invalidRequestDetails` in any way in this story.
- Do not change `src/http/server/plan/refusals.ts`. It is outside this epic.
- Do not change the `PayloadError`, `RegisterProviderError`, `RenameProviderError` or `RemoveProviderError` arms of `toHttpError`.
- The field-decisions walk covers the query, request and response slots only, so no `error-details.ts` edit would move a fixture row in any case. Story 2 already regenerated the fixture for the payload union.

## Verify

- Add to `src/http/server/credential/refusals.test.ts` a test named `"no credential refusal emits ids"` asserting that `toHttpError(new SetDefaultProviderError("kind-not-chainable", "m")).details` deep-equals `{ refusal: "kind-not-chainable" }`, and that the text of `src/http/server/credential/refusals.ts`, read through `readFileSync`, contains no occurrence of `ids`. Scope the file scan to the credential directory. A scan over all of `src/http/server/` fails on the live plan producer.
- Run `node --test --test-timeout=60000 src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/http/contract/error-details.test.ts src/http/server/plan/refusals.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts scripts/publish-contract.test.ts`; it exits 0. The two plan test files are the regression guard that Part B stayed unimplemented.
- Run `grep -rn "default-already-set" src/`; it returns nothing.
- Run `npm run verify`; it exits 0. This is the gate that closes the coupled unit of Stories 5, 6 and 7.
- Proof: `PASS EPIC-021` for `src/http/server/credential/*.test.ts`. Hermetic coverage "The transfer" bullet 10 is delivered **in part**: the `Object.keys(error).sort()` clause is delivered by Story 5, and the `invalidRequestDetails.safeParse({ refusal: "x", ids: [] })` and all-server `grep` clauses are blocked with Part B.
