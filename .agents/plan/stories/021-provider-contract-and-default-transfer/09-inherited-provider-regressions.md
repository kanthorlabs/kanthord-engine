# Story 9 — inherited provider regressions

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 8.

This story adds no behaviour. It re-runs the EPIC 101 proofs this epic edits and labels them regressions.

## Change

- Add no production code and change no production file.
- Add a `regression` label to the suite descriptions of the EPIC 101 cases this epic left in place, so a later reader knows they are inherited rather than new. Label exactly these cases and no others:
  - `src/commands/provider/set-default-provider.test.ts` — the unknown-id `not-found` case, the `kind-not-chainable` case, the already-stamped no-op case, the corrupted-`payload_tag` case and the throwing-`events.append` rollback case.
  - `src/commands/provider/register-provider.test.ts` — the case asserting the first `llm` registration auto-stamps `set_default_at` and appends `provider.defaultSet`.
  - `src/commands/provider/remove-provider.test.ts` — the case asserting a stamped holder is refused with a `default-chain` blocker.
- Add one case to `src/commands/provider/remove-provider.test.ts` named `"a transfer does not make a holder removable"`. Register llm A, register llm B, transfer to B, then call `removeProvider` on B. Assert it throws a `RemoveProviderError` whose `refusal` is `"binding-in-use"` and whose `blockers` deep-equals `[{ kind: "default-chain" }]`. Then call `removeProvider` on A and assert it succeeds, because A no longer holds the default.

## Constraints

- Change no assertion of an inherited case. A label is a title change and nothing else.
- Add no case to `src/commands/provider/rename-provider.test.ts`. Rename is untouched by this epic.
- Add no case to `src/queries/provider/*.test.ts`. The queries are untouched; they are re-run as a regression proof only.

## Verify

- Run `node --test --test-timeout=60000 src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts`; it exits 0.
- Run the full EPIC Proof block; it prints `PASS EPIC-021`.
- Run `node scripts/publish-contract.ts "$(mktemp -d)"`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: the whole `PASS EPIC-021` block, plus Hermetic coverage "The transfer" bullet 11.
