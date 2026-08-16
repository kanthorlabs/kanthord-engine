# Story 5 — `provider.setDefault` transfers

Epic: `.agent/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: EPIC 101. Coupled with Stories 6 and 7; run no full gate between them.

## Change

- Edit `src/commands/provider/set-default-provider.ts`.
- Replace the refusal union at lines 24-25 with `export type SetDefaultProviderRefusal = "not-found" | "kind-not-chainable";`.
- Rewrite `SetDefaultProviderError` at lines 27-43 to carry `refusal` alone:

```ts
export class SetDefaultProviderError extends Error {
  readonly refusal: SetDefaultProviderRefusal;

  constructor(refusal: SetDefaultProviderRefusal, message: string) {
    super(message);
    this.name = "SetDefaultProviderError";
    this.refusal = refusal;
  }
}
```

Delete the `ids` field at line 29 and the `ids` constructor parameter at line 34.

- Keep lines 64-85 exactly as they are: the target select, the `not-found` refusal, the `kind-not-chainable` refusal before any clock call, and the already-stamped early return that writes nothing and appends nothing.
- Replace the holder lookup and refusal at lines 86-97 with a clear of every other holder. Select with `transaction.all`:

```ts
const others = transaction.all(
  "SELECT id, name, kind FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL AND id <> ?",
  [input.id],
) as readonly Readonly<{ id: string; name: string; kind: ProviderKind }>[];
```

Sort the result in the command, never in SQL, with `[...others].sort((a, b) => Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)))`. That matches the id ordering `src/commands/provider/remove-provider.ts:48-52` already uses for its blocker list.

- Call `dependencies.clock.now()` exactly once, before the clearing loop, and bind it to `stampedAt`. Every write and every event of the transaction carries that one value.
- For each other holder, in the sorted order, run `UPDATE provider SET set_default_at = NULL, updated_at = ? WHERE id = ?` with `[stampedAt, other.id]`, and append the `provider.defaultUnset` event Story 6 specifies. The update and its append happen per row, in the sorted order, before the next row is touched.
- Then stamp the target with the existing `UPDATE provider SET set_default_at = ?, updated_at = ? WHERE id = ?` at lines 99-102 and append the existing `provider.defaultSet` at lines 103-114, both unchanged and both carrying `stampedAt`.
- Keep the return shape at lines 115-119 and `projectView` at lines 129-161 unchanged.

## Constraints

- Every read and every write of this command stays inside the one `dependencies.storage.transact` call opened at line 64. Open no second transaction.
- Call `dependencies.clock.now()` exactly once per successful transfer, and never on the `not-found`, the `kind-not-chainable` or the already-stamped path.
- Sort in the command through `Buffer.compare`, not with `ORDER BY` and not with the default `Array.prototype.sort` string comparison.
- Clear **every** other holder, not the first one. A `LIMIT` in the select is a defect.
- Do not repair a database that holds two stamped `llm` rows and names one of them: that call takes the already-stamped early return, writes nothing and leaves both stamped. This is the decided behaviour, not a bug.
- Keep the projection fallback: a `crypto.open`, `deserializePayload` or `projectPayload` throw returns `projection: null` and changes no state and no event.
- Import no query and no other command.
- `src/commands/provider/register-provider.ts`, `rename-provider.ts` and `remove-provider.ts` change in no way.

## Verify

- Rewrite the affected cases of `src/commands/provider/set-default-provider.test.ts` and add the transfer cases. Keep the existing harness: `createMigratedStorage()`, `createMockClock({ start: 1700000000000, step: 1000 })`, `createMockIdGenerator`, the real `AesGcmCrypto` with `Buffer.alloc(32, 7)`, the real `SqliteEventLog`, and the `readProvider` / `readEvents` / `countRows` read-back helpers.
- **Pin the event read order before any order assertion.** `readEvents` at `src/commands/provider/set-default-provider.test.ts:113-119` runs `SELECT … FROM event` with no `ORDER BY`, so it does not read append order today, and these tests mint event ids from `createMockIdGenerator` rather than from the production monotonic factory. Two edits make every order assertion of Stories 5 and 6 deterministic, and both are required:
  - Add `ORDER BY id ASC` to the `readEvents` statement.
  - Seed `createMockIdGenerator` with a ULID list that is strictly ascending bytewise, and long enough for every event and provider each case mints. Write the list as literals in the test file; derive none at run time.
    Without both, event order is a build-time fixture accident, not a pinned fact.
- Delete the case at lines 205-250 titled for `default-already-set`. Its replacement is the transfer case below.
- Keep unchanged: the unknown-id `not-found` case; the `kind-not-chainable` case asserting the git row's `set_default_at` is still `null`; the already-stamped no-op case asserting zero clock calls, unchanged `set_default_at`, unchanged `updated_at` and an unchanged event count; the corrupted-`payload_tag` case; the throwing-`events.append` rollback case.
- Add `"a transfer clears the previous holder and stamps the target"` — register llm A, which `registerProvider` auto-stamps, then register llm B, then snapshot both rows and the event count, then `setDefaultProvider(B)`. Assert A's `set_default_at` is `null`; B's is non-null; A's `updated_at`, B's `updated_at` and B's `set_default_at` are all the same value; and exactly two events were appended, read by `id`, whose `type` values deep-equal `["provider.defaultUnset", "provider.defaultSet"]` and whose `subject_id` values deep-equal `[A, B]`.
- Add `"a transfer clears every other holder in Buffer.compare id order"` — insert three stamped `llm` rows by direct `INSERT`, add a fourth unstamped row, then `setDefaultProvider` on the fourth. Assert exactly four events were appended in this transfer, that the first three are `provider.defaultUnset` with `subject_id` equal to the three cleared ids in `Buffer.compare` order, that the fourth is `provider.defaultSet`, and that exactly one row holds a non-null `set_default_at` afterwards.
- Add `"a duplicate-holder database is not repaired"` — stamp two `llm` rows by direct `INSERT`, then `setDefaultProvider` on one of them. Assert the call returns a view, that neither `set_default_at` changed, that neither `updated_at` changed, that no event was appended, and that both rows are still stamped.
- Add `"a transfer rolls back whole"` — an `EventLog` fake whose `append` throws on the first call. Assert the call throws, that both `set_default_at` values and both `updated_at` values are exactly what they were before, and that the event row count is unchanged.
- Add `"a transfer with an unreadable target still clears the previous holder"` — set the target row's `payload_tag` to sixteen zero bytes, then transfer. Assert `view.projection === null`, that the previous holder was cleared, and that both events were appended.
- Add `"a reentrant transaction refuses and leaves one holder"` — an `EventLog` fake whose `append` calls `dependencies.storage.transact(() => {})`. Assert the call throws a `StorageError` whose `code` is `"storage-transaction-failed"` and whose `message` is `"a transaction is already open"`, that exactly one row holds a non-null `set_default_at` afterwards, and that the event row count is unchanged. Race no timers.
- **Name what that test proves and what it does not.** It proves one of the three mechanisms D1 and D3 rely on: `assertIdle` refuses a second transaction on one `SqliteStorage` instance. It does **not** exercise a second top-level transfer, a second SQLite connection, `BEGIN IMMEDIATE` serialization between connections, or the home-lock exclusion between daemon processes — a competing process does not enter through the first transaction's callback. The EPIC's Hermetic bullet 9 calls this a proof of the whole serialization claim; it is a proof of the first mechanism only. Write the test title and the story's claim to that narrower fact, and assert nothing about cross-process behaviour that this harness cannot observe.
- Add `"no refusal carries ids"` — for the `not-found` and the `kind-not-chainable` refusals, assert `Object.keys(error).sort()` deep-equals `["name", "refusal"]`.
- Run `node --test --test-timeout=60000 src/commands/provider/set-default-provider.test.ts` during the coupled batch of Stories 5, 6 and 7.
- After Story 7, run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/commands/provider/*.test.ts`, plus Hermetic coverage "The transfer" bullets 1 and 3 to 9, and the first clause of bullet 10.
