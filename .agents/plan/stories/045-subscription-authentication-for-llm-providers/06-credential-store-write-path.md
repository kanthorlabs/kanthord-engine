# Story 6 — The store adapter reads and writes an oauth credential

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 2 (the oauth payload variant).

The EPIC states that verification "covers an OAuth registration with no edit". That is not
true of the code as it stands, and this story carries the correction — see blocker **B2**
in the index. Two facts force it:

- `createStore` (`src/services/provider-auth/pi-ai.ts:30-56`) returns an `api_key`
  credential unconditionally, and `ProviderAuthRow` (`src/services/provider-auth/index.ts:17-22`)
  has a required `apiKey: string`. An oauth row has no api key.
- `probe` refuses any vendor whose `provider.auth.apiKey` is `undefined`
  (`src/services/provider-auth/pi-ai.ts:120-125`), and `openai-codex` has no `auth.apiKey`
  at all. Without this edit, `provider.verify` refuses every Codex registration.

## Change

### `src/services/provider-auth/index.ts`

1. Replace `ProviderAuthRow` (`:17-22`) with a transport union that also carries the
   provider row id, which the write path needs:

   ```ts
   export type ProviderAuthRowBase = Readonly<{
     providerId: string;
     vendorId: string;
     defaultModel: string;
     baseUrl: string | null;
   }>;

   export type ProviderAuthRow = ProviderAuthRowBase &
     (
       | Readonly<{ transport: "api-key"; apiKey: string }>
       | Readonly<{
           transport: "oauth";
           credential: Readonly<Record<string, unknown>>;
         }>
     );
   ```

2. Add the write port and its refusal:

   ```ts
   export interface CredentialWriter {
     write(
       providerId: string,
       credential: Readonly<Record<string, unknown>>,
     ): void;
   }
   ```

   It is synchronous, because `Storage.transact` is synchronous
   (`src/services/storage/index.ts:33`) and refuses a thenable result
   (`src/services/storage/connection.ts:90-101`).

### `src/services/provider-auth/credential-writer.ts` (new file)

A service implementation may import any service interface, so this file imports `Storage`,
`Crypto`, `EventLog` and `Clock` interfaces. It imports no other implementation.

```ts
export type SqliteCredentialWriterDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  events: EventLog;
  clock: Clock;
}>;

export class SqliteCredentialWriter implements CredentialWriter {
  write(providerId, credential): void { … }
}
```

`write` performs exactly one `storage.transact`, and inside it:

1. `SELECT id, name, kind, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE id = ?`.
   If the row is `undefined`, return without writing and without appending. A refresh for a
   provider that was removed mid-flight is a no-op, not an error.
2. `crypto.open` the payload, `deserializePayload("llm", text)`. If the payload is not the
   oauth arm, return without writing.
3. Build the new payload by replacing only `credential`, keeping `provider` and
   `defaultModel` byte-identical, then `serializePayload("llm", next)` and `crypto.seal`.
4. `UPDATE provider SET payload_ciphertext = ?, payload_iv = ?, payload_tag = ?, key_version = ?, updated_at = ? WHERE id = ?`
   with `clock.now()` as `updated_at`. Name every column; never `SET *`.
5. Append exactly one event:

   ```ts
   events.append(transaction, {
     subjectKind: "provider",
     subjectId: providerId,
     type: "provider.credentialRefreshed",
     actorKind: "daemon",
     actorId: "daemon",
     payload: { name: row.name, kind: "llm", refreshedAt: updatedAt },
   });
   ```

   **The actor is `daemon`, not the configured actor name, and this is enforced.**
   `src/main.test.ts:505-514` asserts that no handler takes `actor: settings.actor` and
   that `settings.actor` appears exactly **once** in `src/main.ts` — it keeps one job, the
   bootstrap row name. A refresh is initiated by the library inside the daemon with no human
   in the request, so `daemon` is also the truthful attribution; `"daemon"` is a member of
   `eventActorKinds` (`src/domain/event.ts:6`).

   `actor` is therefore **not** a dependency of the writer. Drop it from
   `SqliteCredentialWriterDependencies`; the two literals above are fixed.

A throw anywhere inside rolls the whole transaction back, so a failing refresh leaves the
ciphertext byte-identical and appends no event. That is the required behaviour, and it is
the transaction's behaviour — write no compensating logic.

### `src/domain/event-type.ts`

Insert `"provider.credentialRefreshed"` into the bytewise-sorted `eventTypes` array. It
sorts **before** `"provider.defaultSet"` (line 24), because `c` < `d`, and after
`"project.repositoriesReplaced"` (line 23).

### `src/http/contract/event-payload.ts`

`eventPayloads` is exhaustive over `EventType`, so the new type is a compile error until
its payload exists. Add it in the same position as the type, beside the sibling provider
payloads at `:195-216`:

```ts
"provider.credentialRefreshed": z.strictObject({
  name: z.string(),
  kind: providerKind,
  refreshedAt: fence,
}),
```

`fence` (`:29`) and `providerKind` (`:33`) are the existing locals. Nothing else in the
file changes; the OpenAPI catalogue picks the entry up by construction
(`src/http/contract/openapi.ts:60-64, 233-244`).

### `src/services/provider-auth/pi-ai.ts`

1. `createStore(row)` dispatches on the transport and closes over the optional writer:

   ```ts
   function createStore(
     row: ProviderAuthRow,
     writer: CredentialWriter | undefined,
   ): CredentialStore {
     const current = (): Credential =>
       row.transport === "oauth"
         ? (row.credential as unknown as OAuthCredential)
         : ({ type: "api_key", key: row.apiKey } satisfies ApiKeyCredential);

     return {
       async read(providerId) {
         if (providerId !== row.vendorId) return undefined;
         return current();
       },
       async list() {
         return [
           { providerId: row.vendorId, type: current().type },
         ] satisfies readonly CredentialInfo[];
       },
       async modify(providerId, fn) {
         if (providerId !== row.vendorId) return undefined;
         const next = await fn(current());
         if (next === undefined) return undefined;
         if (next.type === "oauth" && writer !== undefined) {
           writer.write(
             row.providerId,
             next as unknown as Readonly<Record<string, unknown>>,
           );
         }
         return next;
       },
       async delete(providerId) {
         if (providerId !== row.vendorId) return;
       },
     };
   }
   ```

   `fn` returning `undefined` means "leave unchanged" per the library contract
   (`dist/auth/types.d.ts:68-75`), so that path writes nothing and returns `undefined`.
   An `api_key` result is never persisted: rotation is out of scope, and the api-key
   payload has no refresh.

   **Two departures from the library's `modify` contract are deliberate, and both are
   bounded by how the engine constructs the store.** The contract asks for mutual exclusion
   per provider id and for `fn` to see the _current_ credential; this adapter serializes
   nothing and hands `fn` the credential snapshotted when the row was read.

   - `fn` sees a snapshot, because the store is built per probe from a row decrypted before
     the call. **Do not justify this with the snapshot rule of
     `docs/proposal/phase-2/providers-and-credentials.md`.** That rule covers the probe — a
     vendor round-trip the daemon must not hold a database lock across — and it defines what
     a verdict is a statement about. A `SELECT` inside `modify` is a local read of
     microseconds, so re-reading the row there would contradict neither the rule nor its
     reason. The snapshot here is a consequence of the adapter's lifetime, not a requirement,
     and a stale write is a lost update rather than the harmless stale verdict that rule
     accepts.
   - No lock, and none is possible here. `createStore` is built **per probe**
     (`src/services/provider-auth/pi-ai.ts:144`), so two concurrent verifies hold two
     different store objects with no shared state to serialize on. A mutex inside a
     per-request object serializes nothing. Both can refresh from the same token: under
     refresh-token rotation the second usually fails, writes nothing, and surfaces a
     spurious `authentication: "rejected"`; where a vendor grace window lets both succeed,
     the later write wins and one issued pair is orphaned. Neither corrupts the row — the
     write is a whole-payload replace inside one transaction.

   Serializing per provider id needs a process-wide lock the service does not own today.
   Add it only if the human accepts the scope — see blocker **B9** in the index. Do not
   invent a lock in this story, and do not silently claim the contract is met: state both
   departures in `docs/proposal/phase-2/providers-and-credentials.md` in Story 12.

2. Relax the probe guard at `src/services/provider-auth/pi-ai.ts:120-125` so an oauth-only
   vendor is admitted:

   ```ts
   const usable =
     row.transport === "oauth"
       ? provider?.auth.oauth !== undefined
       : provider?.auth.apiKey !== undefined;
   if (provider === undefined || !usable) {
     throw new ProviderAuthError("vendor-not-catalogued", …);
   }
   ```

   Keep the existing message text for the api-key arm; use
   `` `vendor ${row.vendorId} has no oauth auth in the pi-ai catalog` `` for the oauth arm.

3. Pass the writer through: add `credentialWriter?: CredentialWriter` to
   `PiAiProviderAuthDependencies` and call `createStore(row, this.#credentialWriter)` at
   `src/services/provider-auth/pi-ai.ts:144`.

### `src/queries/provider/verify-provider.ts`

Build the union row from the parsed payload. The file currently imports `llmPayload`
(`src/queries/provider/verify-provider.ts:1`) and reads `apiKey` from it.

- Parse the stored payload with `deserializePayload("llm", text)`.
- Oauth arm → `{ providerId: row.id, vendorId: payload.provider, defaultModel: payload.defaultModel, baseUrl: null, transport: "oauth", credential: payload.credential }`.
- Api-key arm → the existing four fields plus `providerId: row.id` and
  `transport: "api-key"`.
- Add `id` to the selected column list (`src/queries/provider/verify-provider.ts:53-59`)
  if it is not already there — it is, at `:54`.

No refusal, no branch and no result field changes. The verdict mapping is untouched.

### `src/main.ts`

Construct the writer and hand it to the service. `events` exists at `src/main.ts:250`, and
`providerAuth` is built at `:359`:

```ts
const credentialWriter = new SqliteCredentialWriter({
  storage,
  crypto,
  events,
  clock,
});
const providerAuth = new PiAiProviderAuth(fetch, { credentialWriter });
```

No `actor` is passed. `src/main.test.ts:505-514` fails if `settings.actor` appears a second
time in `src/main.ts` or reaches a handler.

Note that `src/main.test.ts:516-519` asserts `actor: "daemon"` appears exactly **four**
times in `src/main.ts`. The literal above lives in `credential-writer.ts`, not in
`main.ts`, so that count is unaffected — confirm by grep after the edit rather than
assuming it.

### Tests

**`src/services/provider-auth/credential-writer.test.ts` (new file).** Real SQLite through
`createMigratedStorage()`, `AesGcmCrypto` with `Buffer.alloc(32, 7)`, `SqliteEventLog`,
`createMockClock`, `createMockIdGenerator` — the exact fixture set of
`src/commands/provider/register-provider.test.ts:84-121`.

1. `it("re-encrypts the row and appends exactly one provider.credentialRefreshed event")` —
   seed one oauth provider row; write a rotated credential; assert the decrypted payload
   carries the new `access` and `refresh`, that `provider` and `defaultModel` are
   unchanged, that `updated_at` equals the mock clock, and that the event table holds
   exactly one new row whose `payload_json` deep-equals
   `{ name, kind: "llm", refreshedAt: <clock> }`.
2. `it("changes no other column")` — assert `id`, `name`, `kind` and `set_default_at` are
   byte-identical before and after, using `tableBytes` semantics or a column-by-column
   deep-equal.
3. `it("writes new ciphertext bytes")` — assert `payload_ciphertext` differs from the
   original and that the fixture token values do not appear in the raw column bytes.
4. `it("a failing write leaves the ciphertext byte-identical and appends no event")` —
   inject an `events.append` that throws; assert the transaction rolled back, the
   ciphertext is byte-identical, and the event count is unchanged.
5. `it("is a no-op for a provider row that no longer exists")` — assert no throw, no row,
   no event.
6. `it("is a no-op for an api-key payload")` — assert the row and the event count are
   unchanged.

**`src/services/provider-auth/pi-ai.test.ts`.** Extend the existing store-isolation test at
`:379` and add:

7. `it("serves the oauth credential to the library store")` — through the `createModels`
   seam, assert `store.read("openai-codex")` deep-equals the stored oauth credential
   including its extra keys, and `store.list()` deep-equals
   `[{ providerId: "openai-codex", type: "oauth" }]`.
8. `it("persists a refreshed oauth credential through the writer")` — a recording
   `CredentialWriter`; drive `store.modify(vendorId, async () => rotated)`; assert the
   writer received the provider row id and the rotated credential, and that `modify`
   resolved with the rotated credential.
9. `it("writes nothing when the modify callback answers undefined")` — assert the writer
   recorded no call and `modify` resolved `undefined`.
10. `it("writes nothing for an api-key credential")` — assert no writer call.
11. `it("admits an oauth-only vendor")` — a row with `transport: "oauth"` and
    `vendorId: "openai-codex"` does **not** throw `vendor-not-catalogued` at the guard.
    Assert the probe proceeds past the guard (the existing fetch double answers it).
12. `it("still refuses an api-key row for a vendor with no api-key auth")` — a
    `transport: "api-key"` row for `"openai-codex"` throws `vendor-not-catalogued`.

**`src/queries/provider/verify-provider.test.ts`.** Add:

13. `it("verifies an oauth registration")` — seed an oauth provider row and assert the
    probe receives a row with `transport: "oauth"` and the exact credential, and that the
    result shape is unchanged from the api-key case.
14. `it("keeps the api-key path unchanged")` — an existing test already covers it; assert
    the probe now also receives `transport: "api-key"` and `providerId`.

**`src/http/contract/event-payload.test.ts`.** Add one case asserting the new payload
schema parses `{ name: "work-codex", kind: "llm", refreshedAt: 1_700_000_000_000 }` and
rejects an extra key, matching the sibling provider cases.

## Constraints

- Exactly one `storage.transact` per `write`, holding the update and the event append.
  `docs/proposal/phase-1/domain.md` requires the transition and its event in one
  transaction.
- The writer names every updated column. No `SELECT *`, no `SET *`.
- The writer is a no-op for a missing row, a non-oauth payload and an `undefined` callback
  result. None of the three throws.
- `provider`, `defaultModel`, `id`, `name`, `kind` and `set_default_at` are never written
  by the refresh path.
- `probe` keeps its existing outcome mapping. This story does not touch `verdict.ts`.
- No token value reaches any event payload — the payload carries `name`, `kind` and
  `refreshedAt` only.

## Verify

```
node --test \
  src/services/provider-auth/credential-writer.test.ts \
  src/services/provider-auth/pi-ai.test.ts \
  src/queries/provider/verify-provider.test.ts \
  src/http/contract/event-payload.test.ts
npm run verify
```

Asserts: one re-encrypted row and exactly one `provider.credentialRefreshed` event with an
exact payload, every other column unchanged, a rolled-back failure leaving byte-identical
ciphertext and no event, the three no-op paths, the oauth credential served to and written
back through the library store with extra keys intact, and the oauth-only vendor admitted
by the probe guard.

Proof: contributes to `src/services/provider-auth/pi-ai.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
