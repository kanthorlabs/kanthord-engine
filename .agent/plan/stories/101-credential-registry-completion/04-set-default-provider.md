# Story 4 — provider.setDefault

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Depends on: Story 3 and coupled Stories 5 through 8.

## Change

- Add `src/commands/provider/set-default-provider.ts` with `setDefaultProvider({ storage, crypto, clock, events }, { id, actor }): ProviderView`.
- Export `SetDefaultProviderDependencies`, `SetDefaultProviderInput`, `SetDefaultProviderRefusal` and `SetDefaultProviderError` from that file.
- Set the refusal union to `not-found | kind-not-chainable | default-already-set`; only `default-already-set` owns enumerable `ids`, containing one holder id.
- Use exact messages `no provider <id>`, `provider <id> of kind git cannot join the default chain` and `provider <holder-id> already holds the default`, respectively.
- Select `id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at` for the target inside one transaction.
- Refuse no target as `not-found`; refuse git as `kind-not-chainable` before a clock call or write.
- Return an already-stamped target unchanged without a clock call, write or event.
- Find another stamped LLM with `SELECT id FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL AND id <> ? ORDER BY id ASC LIMIT 1`; refuse it as `default-already-set` with `ids: [id]`.
- Otherwise call the clock once, update `set_default_at` and `updated_at` to that value and append `provider.defaultSet` in the same transaction.
- Set its envelope to subjectKind `provider`, subjectId equal to input id, actorKind `human`, actorId equal to input actor and payload `{ name, kind, setDefaultAt }`.
- After the transaction, derive projection through `crypto.open`, `deserializePayload` and `projectPayload`; return null if any call throws.
- Add `src/http/server/credential/set-default-provider.ts`; read path id, call the command once with the configured actor, return status 200 and map command errors through `toHttpError`.

## Constraints

- Do not import a query or another command.
- Do not expose encrypted columns, plaintext payloads or credentials through a view or error.
- Keep this story coupled to Stories 5 through 8; the route remains unusable until Story 7 and composition remains incomplete until Story 8.

## Verify

- Add `src/commands/provider/set-default-provider.test.ts` with real temporary SQLite and exact tests for unknown id, git refusal, another holder, self no-op, successful stamp, valid projection, broken-tag null projection and event-failure rollback.
- Assert git refusal leaves its stamp null; another-holder refusal returns the singleton holder id and leaves both rows unchanged; self no-op leaves stamp, update time and event count unchanged.
- Assert success uses one timestamp for both columns and event payload; assert every event envelope field, and assert a throwing EventLog rolls both columns back.
- Add `src/http/server/credential/set-default-provider.test.ts` with real Koa tests for 200, missing id refusal mapping, git 400 and holder 400 with exact ids.
- Run `node --test src/commands/provider/set-default-provider.test.ts` during the coupled batch.
- After Story 8, run `node --test src/commands/provider/set-default-provider.test.ts src/http/server/credential/set-default-provider.test.ts`; it exits 0.
- After Story 8, run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 38, 40 and 45, plus Hermetic coverage lines 55-57 and 60.
