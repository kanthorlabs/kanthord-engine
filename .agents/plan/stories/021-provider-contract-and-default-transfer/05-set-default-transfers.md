# Story 5 — `provider.setDefault` transfers

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
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
- Collect the cleared rows while the loop runs, in the same sorted order, as `{ id, name }` values. That list is the `displaced` member below; build it from the rows already selected and read the table no second time.
- Keep `projectView` at lines 129-161 unchanged. Change the return at lines 115-119 to spread its result and add `displaced`:

```ts
return {
  ...projectView(
    dependencies,
    outcome.row,
    outcome.setDefaultAt,
    outcome.updatedAt,
  ),
  displaced: outcome.displaced,
};
```

The already-stamped early return of lines 79-85 and the empty-registry path both carry `displaced: []`.

- Add two types to `src/commands/provider/set-default-provider.ts`, after `SetDefaultProviderInput` at lines 19-22. **Do not edit `src/domain/provider-view.ts`**: `ProviderView` is the shared entity view and a one-operation result belongs with its command, as `src/commands/plan/import-plan.ts:65` declares `ImportPlanResult`.

```ts
export type DisplacedProvider = Readonly<{
  id: string;
  name: string;
}>;

export type ProviderDefaultTransfer = ProviderView &
  Readonly<{ displaced: readonly DisplacedProvider[] }>;
```

- Change the return type of `setDefaultProvider` from `ProviderView` to `ProviderDefaultTransfer`. The existing `ProviderView` import at line 10 is unchanged, because the new type extends it in the same file.
- Edit `src/http/contract/credential.ts`. Add `displacedProvider` and extend the response, replacing `export const providerSetDefaultResponse = providerView;` at line 60:

```ts
export const displacedProvider = z.strictObject({
  id: z.string(),
  name: z.string(),
});

export const providerSetDefaultResponse = providerView.extend({
  displaced: z.array(displacedProvider),
});
```

- Add `EXAMPLE_ULID_B` to `src/http/contract/example-literal.ts`, a second valid ULID distinct from `EXAMPLE_ULID`. No test enumerates that module's exports.
- Add `displaced` to `providerSetDefaultExamples.success` at `src/http/contract/credential.ts:145-153`, as its last member, holding **one** entry: `{ id: `provider_${B}`, name: "anthropic" }` with `B` the new literal. An empty list would publish no example of the member, per D9.
- Edit `src/http/server/credential/set-default-provider.ts`. Change the dependency type at line 9 from `(input: SetDefaultProviderInput) => ProviderView` to `(input: SetDefaultProviderInput) => ProviderDefaultTransfer`. Add `ProviderDefaultTransfer` to the existing `commands/provider/set-default-provider.ts` type import at line 4, and delete the now-unused `ProviderView` import at line 3. `http/server/` may import `commands/`, and `src/http/server/plan/import-plan.ts:5` is the precedent. Change the function body in no way; `return { status: 200, body: view }` stays exactly as it is.
- Regenerate `src/http/contract/field-decisions.fixture.ts` through `node scripts/field-decisions-probe.mjs --write`, then confirm with the same command and no flag. Two rows appear, `provider.setDefault.response#/properties/displaced/items/properties/id required=true nullable=false enum=-` and the same for `name`, beside the existing `provider.setDefault.response` rows at lines 407-418. Never edit that file by hand, and expect no other row to move.

## Constraints

- Every read and every write of this command stays inside the one `dependencies.storage.transact` call opened at line 64. Open no second transaction.
- Call `dependencies.clock.now()` exactly once per successful transfer, and never on the `not-found`, the `kind-not-chainable` or the already-stamped path.
- Sort in the command through `Buffer.compare`, not with `ORDER BY` and not with the default `Array.prototype.sort` string comparison.
- Clear **every** other holder, not the first one. A `LIMIT` in the select is a defect.
- Do not repair a database that holds two stamped `llm` rows and names one of them: that call takes the already-stamped early return, writes nothing and leaves both stamped. This is the decided behaviour, not a bug.
- Keep the projection fallback: a `crypto.open`, `deserializePayload` or `projectPayload` throw returns `projection: null` and changes no state and no event.
- Import no query and no other command.
- `src/commands/provider/register-provider.ts`, `rename-provider.ts` and `remove-provider.ts` change in no way.
- `ProviderView` gains no member. `provider.register`, `provider.list`, `provider.show` and `provider.rename` keep the exact body they answer today, and `providerView` in `src/http/contract/credential.ts:41-48` is not edited.
- `displaced` is required, so build it on every returned path and never omit it. An `undefined` member is a defect.
- Nest nothing: the response is `providerView`'s members plus `displaced` at the top level, never `{ provider, displaced }`.
- Give `displaced` no `kind` member and no timestamp.
- The handler body branches on nothing. A handler that reads `displaced.length` to choose a status is a defect.

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
- Add `"a transfer names the row it displaced"` — reuse the two-provider setup of the first transfer case, then assert `view.displaced` deep-equals `[{ id: <A>, name: <A's registered name> }]`, and that `view.id`, `view.setDefaultAt` and `view.updatedAt` are B's values.
- Add `"the displaced order is the unset event order"` — reuse the three-holder case, then assert `view.displaced.map((entry) => entry.id)` deep-equals the `subject_id` values of the three `provider.defaultUnset` events read by event `id`. Assert one list against the other, not each against a literal.
- Add `"nothing displaced is an empty list"` — two cases in one: `setDefaultProvider` on the row that already holds the default, and `setDefaultProvider` on the only `llm` row of a registry that has one holder. Assert `view.displaced` deep-equals `[]` for both.
- Add to `src/http/contract/credential.test.ts`: `providerSetDefaultResponse.safeParse` succeeds on `providerSetDefaultExamples.success`; fails on the same object with `displaced` deleted; fails on the same object with `displaced: [{ id: "x", name: "y", kind: "llm" }]`; and `providerView.safeParse` fails on a body carrying `displaced`, which pins that the four other provider operations did not gain the member.
- Edit `src/http/server/credential/set-default-provider.test.ts`. Three edits, and the second is the one a story that omitted it would leave to be discovered as a failure:
  - The stub command's returned `view` gains a `displaced` member, or `providerSetDefaultResponse.parse` at line 44 throws on a missing required key.
  - The `Object.keys(parsed).sort()` literal at line 45 gains `"displaced"` in sorted position. Read the existing array and insert, rather than rewriting it.
  - Add a case: a transfer through the handler answers `200` with a body whose `displaced` is the command's list, unmodified and in the same order.
- Add `"no refusal carries ids"` — for the `not-found` and the `kind-not-chainable` refusals, assert `Object.keys(error).sort()` deep-equals `["name", "refusal"]`.
- Run `node --test --test-timeout=60000 src/commands/provider/set-default-provider.test.ts` during the coupled batch of Stories 5, 6 and 7.
- After Story 7, run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/commands/provider/*.test.ts`, `src/http/contract/credential.test.ts` and `src/http/server/credential/set-default-provider.test.ts`, plus every Hermetic coverage bullet of "The transfer" except the one naming the exact event payloads, which Story 6 owns, and the first clause of the credential `ids` bullet.
