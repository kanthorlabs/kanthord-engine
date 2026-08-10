# Story 3 — First registration stamps the chain

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Depends on: Stories 1 and 2.

## Change

- In `registerProvider` at `src/commands/provider/register-provider.ts:54-99`, retain one provider id mint and one `clock.now()` call before the transaction.
- Inside the existing transaction, query `SELECT id FROM provider WHERE kind = 'llm' LIMIT 1` only when `input.kind === "llm"`.
- Set `setDefaultAt` to `updatedAt` only when that query returns no row; use null for every git row and every later LLM row.
- Insert `setDefaultAt` instead of the literal null at `src/commands/provider/register-provider.ts:69-82` and return it in the view.
- Append `provider.registered` first with payload `{ name, kind }`.
- When `setDefaultAt` is non-null, append `provider.defaultSet` second in the same transaction with subject kind `provider`, actor kind `human`, the same actor and payload `{ name, kind, setDefaultAt }`.

## Constraints

- Test existence of any LLM row, not existence of a stamped row.
- Append no `provider.defaultSet` event for git or later LLM registrations.
- Keep provider insertion and both event appends in one storage transaction.

## Verify

- Update `src/commands/provider/register-provider.test.ts:217-242` to assert the first LLM row has `set_default_at`, `updated_at` and `view.setDefaultAt` equal to `1700000000000`.
- Add a test whose event id queue sorts the first LLM events as `["provider.registered", "provider.defaultSet"]`; assert the second payload JSON is `{"name":"anthropic-bot","kind":"llm","setDefaultAt":1700000000000}`.
- Add separate tests for a second LLM row, an existing unstamped LLM row and git rows; each stores null and appends only `provider.registered`.
- Add an atomicity test whose EventLog delegates the first append to `SqliteEventLog` and throws on the second; assert provider and event counts both equal zero.
- Run `node --test src/commands/provider/register-provider.test.ts`; it exits 0.
- Run `npm run verify`; it exits 0.
- Proof: EPIC Proof lines 38 and 45, plus Hermetic coverage lines 51-54.
