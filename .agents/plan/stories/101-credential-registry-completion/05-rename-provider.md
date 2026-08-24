# Story 5 — provider.rename

Epic: `.agents/plan/epics/101-credential-registry-completion.md`
Depends on: Story 2 and coupled Stories 4 and 6 through 8.

## Change

- Add `src/commands/provider/rename-provider.ts` with `renameProvider({ storage, crypto, clock, events }, { id, name, actor }): ProviderView`.
- Export dependency, input, refusal and error types; set refusals to `not-found | name-taken` and exact enumerable error keys to `name` and `refusal`.
- Use exact messages `no provider <id>` and `a provider named <name> is already registered`.
- Select the same nine named provider columns as Story 4 inside one transaction.
- Refuse an unknown id as `not-found`; query another row by name and refuse it as `name-taken`.
- Return a rename to the current name unchanged without a clock call, write or event.
- Otherwise call the clock once, update only `name` and `updated_at`, and append `provider.renamed` in the transaction.
- Set its envelope to subjectKind `provider`, subjectId equal to input id, actorKind `human`, actorId equal to input actor and payload `{ from, to }`.
- After the transaction, derive projection through `crypto.open`, `deserializePayload` and `projectPayload`; return null if any call throws.
- Add `src/http/server/credential/rename-provider.ts`; parse `providerRenameRequest`, read path id, inject actor, call once, return 200 and map errors through `toHttpError`.

## Constraints

- Never update `payload_ciphertext`, `payload_iv`, `payload_tag`, `key_version`, `kind` or `set_default_at`.
- Do not import a query or another command.
- Keep this story coupled to Stories 4 and 6 through 8.

## Verify

- Add `src/commands/provider/rename-provider.test.ts` with real SQLite tests for unknown id, name taken, same-name no-op, success, projection, broken-tag null projection and event rollback.
- Assert name-taken leaves both names unchanged and owns only `name` and `refusal`.
- Snapshot all four encrypted columns before success and assert each remains byte-identical with `Buffer.compare(...) === 0`; decrypt and assert the same projection.
- Assert success appends one `provider.renamed` payload `{"from":"github-bot","to":"github-release"}` and event failure restores the old name and update time.
- Assert every renamed event envelope field and exact payload `{"from":"github-bot","to":"github-release"}`.
- Add `src/http/server/credential/rename-provider.test.ts` with real Koa tests for valid 200, unknown id 404 and name-taken 400.
- For an empty body, assert 400 invalid-request, message `the provider rename body is invalid`, and zero command calls.
- Run `node --test src/commands/provider/rename-provider.test.ts` during the coupled batch.
- After Story 8, run `node --test src/commands/provider/rename-provider.test.ts src/http/server/credential/rename-provider.test.ts`; it exits 0.
- After Story 8, run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 38, 40 and 45, plus Hermetic coverage lines 58-60.
