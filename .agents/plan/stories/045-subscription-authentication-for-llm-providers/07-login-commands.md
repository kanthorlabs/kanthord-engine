# Story 7 — Three commands drive the login

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Depends on: Story 3 (the table), Story 5 (the service methods).

Three structural rules shape every file here. The first two are the reason the code looks
the way it does; the third is a correctness trap that a naive reading walks straight into.

- `Storage.transact` is **synchronous** and refuses a thenable result
  (`src/services/storage/connection.ts:90-101`). An `await` cannot sit inside a
  transaction. Each command therefore reads in one transaction, calls the service outside
  it, and writes in a second transaction that re-checks the state it depends on.
- `commands/` may import `domain/` and service **interfaces** only. A command never
  imports another command, so the abort-and-delete pair is written out in each of the two
  files that needs it rather than shared.
- **A throw inside `transact` rolls the transaction back**
  (`src/services/storage/connection.ts:80-88`). Deleting a row and then throwing a refusal
  from inside the same transaction therefore **restores the row**. Every teardown path in
  this story — expiry, `login-lost`, and cancel — must return a refusal marker from the
  transaction callback, let the transaction **commit**, and throw only after it returns.
  Write the pattern once per file:

  ```ts
  const outcome = dependencies.storage.transact((transaction) => {
    // … reads …
    if (expired) {
      transaction.run("DELETE FROM provider_login WHERE id = ?", [row.id]);
      return { kind: "expired" } as const;
    }
    return { kind: "ok", row } as const;
  });
  if (outcome.kind === "expired") {
    throw new …Error("login-expired", …);
  }
  ```

  `providerAuth.abortLogin(id)` is called **after** the commit, immediately before the
  throw. It is synchronous, idempotent and never throws, and running it after the commit
  means a rolled-back delete never leaves a live flow torn down with its row intact.

### The one-transaction rule, and why `start` and `complete` take two

`AGENTS.md` states that a write command opens one transaction. These two commands cannot,
and the reason is structural rather than stylistic: the vendor handshake is asynchronous
and `transact` refuses a thenable, so no single transaction can span the service call. The
epic already accepts this by splitting the login across two requests.

The split is made safe by the database, not by the gap between the transactions:

- `start` — the pre-check is advisory. The partial unique index
  `provider_login_one_pending` is the authority, and the insert is the only arbiter of
  which concurrent `start` wins.
- `complete` — the write is `UPDATE … WHERE id = ? AND state = 'pending'`, so a concurrent
  duplicate loses without corrupting the row, and the command re-reads inside the write
  transaction to decide what it observed.

Record this deviation in `docs/proposal/phase-2/providers-and-credentials.md` in Story 12,
beside the two deployment decisions. It is a deliberate, stated exception — see blocker
**B6** in the index.

## Change

### `src/commands/provider/start-provider-login.ts` (new file)

```ts
export type StartProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
  ids: IdGenerator;
  clock: Clock;
}>;

export type StartProviderLoginInput = Readonly<{
  provider: string;
  answers: Readonly<Record<string, string>>;
}>;

export type StartProviderLoginRefusal =
  | "provider-not-oauth-capable"
  | "login-in-progress"
  | "login-expired"
  | "login-method-unavailable"
  | "login-input-required"
  | "login-failed";

export class StartProviderLoginError extends Error {
  readonly refusal: StartProviderLoginRefusal;
  readonly detail: string;
  …
}

export type StartProviderLoginResult = Readonly<{
  loginId: string;
  method: "manual-code" | "device-code";
  expiresAt: number;
  authUrl?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  pollIntervalMs?: number;
}>;

export const MANUAL_LOGIN_LIFETIME_MS = 600_000;
```

Sequence, exactly:

1. `dependencies.providerAuth.oauthVendors()` — if no entry has `id === input.provider`,
   throw `StartProviderLoginError("provider-not-oauth-capable", …)`. This precedes every
   other step, so the refusal costs zero outbound calls.
2. Transaction one: `SELECT id, state, expires_at FROM provider_login WHERE provider = ? AND state = 'pending'`.
   - No row → continue.
   - Row with `expires_at > clock.now()` → throw
     `StartProviderLoginError("login-in-progress", …)`.
   - Row with `expires_at <= clock.now()` → this request is the first to observe the
     expiry. `DELETE FROM provider_login WHERE id = ?` inside the transaction, return
     `{ kind: "expired", id: row.id }`, and **after the transaction commits** call
     `providerAuth.abortLogin(row.id)` and throw
     `StartProviderLoginError("login-expired", …)`. The next `start` for the vendor then
     succeeds. Throwing from inside the callback would roll the delete back.
3. `const loginId = dependencies.ids.mint("providerLogin")` and
   `const createdAt = dependencies.clock.now()`. The id is minted **before** the service
   call, because the service keys its live flow by it.
4. `const challenge = await dependencies.providerAuth.startLogin({ loginId, vendorId: input.provider, answers: input.answers })`.
   Map a thrown `LoginError` onto the same-named refusal, carrying `detail` through
   unchanged. `login-input-required` therefore reaches the caller with the exact prompt
   message in `detail`.
5. `const expiresAt = challenge.expiresAt ?? createdAt + MANUAL_LOGIN_LIFETIME_MS`. The
   manual arm has no vendor-issued lifetime, so it is `created_at` plus ten minutes; the
   device arm carries the value the service computed at the `device_code` event.
6. Transaction two: insert the row.

   ```sql
   INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at)
   VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)
   ```

   If the insert throws, inspect the error before mapping it. A `StorageError` whose
   message names a `UNIQUE constraint failed` on `provider_login` is the concurrent-start
   case: call `providerAuth.abortLogin(loginId)` and throw
   `StartProviderLoginError("login-in-progress", …)`. **Any other error re-throws
   unchanged**, after `abortLogin`, so a malformed row or a storage fault is never masked
   as `login-in-progress`. Write the predicate as a named helper
   `isPendingLoginConflict(error: unknown): boolean` and unit-test it against both a real
   conflict and an unrelated `StorageError`.

   The index is the authority, not the check in step 2.

   **The concurrent-start race is closed in the service, not here.** Two concurrent `start`
   calls can both pass step 2, because its transaction commits before the service call. The
   guard that actually prevents two live flows is the synchronous per-vendor claim at the top
   of `providerAuth.startLogin` (Story 5): the second caller is refused
   `login-in-progress` before it ever reaches `login()`, so it never binds `anthropic`'s
   fixed callback port. Step 4 therefore maps a `LoginError` with
   `refusal === "login-in-progress"` onto `StartProviderLoginError("login-in-progress", …)`
   like any other refusal.

   The index catch above remains as the backstop for the case no in-memory claim can see: a
   `pending` row left by a previous process. Keep both. Do not add a reservation row and do
   not duplicate the claim in this command.

7. Return the flattened result: always `loginId`, `method` and `expiresAt`, plus
   `authUrl` and `instructions` on the manual arm, or `userCode`, `verificationUri` and
   `pollIntervalMs` on the device arm. The absent arm's keys are omitted, not null.

`instanceId` comes from the dependencies bag as a plain `string`, following
`src/commands/node/claim-node.ts:64`. Add it to `StartProviderLoginDependencies`.

### `src/commands/provider/complete-provider-login.ts` (new file)

```ts
export type CompleteProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
  crypto: Crypto;
  catalog: ModelCatalog;
  clock: Clock;
  instanceId: string;
}>;

export type CompleteProviderLoginInput = Readonly<{
  loginId: string;
  code?: string;
}>;

export type CompleteProviderLoginRefusal =
  | "not-found"
  | "login-expired"
  | "login-lost"
  | "login-pending"
  | "code-required"
  | "code-not-accepted"
  | "login-failed";

export type CompleteProviderLoginResult = Readonly<{
  loginId: string;
  models: readonly string[];
}>;
```

Sequence, exactly:

1. Transaction one:
   `SELECT id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, expires_at FROM provider_login WHERE id = ?`.
   Evaluate the cases in exactly this order. **Expiry is checked before state**, so a
   `completed` row does not replay forever past its deadline:

   - `undefined` → return `{ kind: "not-found" }`, then throw
     `CompleteProviderLoginError("not-found", …)` after the commit.
   - `expires_at <= clock.now()`, **whatever the state** → `DELETE FROM provider_login WHERE id = ?`
     inside the transaction, return `{ kind: "expired", id }`, and after the commit call
     `providerAuth.abortLogin(id)` and throw
     `CompleteProviderLoginError("login-expired", …)`. A replay of the same `loginId`
     afterwards answers `not-found`. The EPIC says the first request to observe _an expired
     row_ tears it down and does not narrow that to `pending`, so a `completed` row expires
     on the same rule — see blocker **B8** in the index.
   - `state === 'completed'` → **replay**. Decrypt the payload, parse it, and return
     `{ loginId, models }` from the stored value. Make no service call, run no `UPDATE`, and
     ignore `input.code` entirely.
   - `state === 'pending'` and `instance_id !== dependencies.instanceId` → `DELETE` inside
     the transaction, return `{ kind: "lost", id }`, and after the commit call
     `providerAuth.abortLogin(id)` and throw
     `CompleteProviderLoginError("login-lost", …)`.
   - `state === 'pending'`, `method === 'device-code'` and `input.code !== undefined` →
     throw `CompleteProviderLoginError("code-not-accepted", …)` and change no row.

2. `const outcome = await dependencies.providerAuth.completeLogin({ loginId, code })`.
   - `{ status: "lost" }` → read the row in a second transaction and settle on its state,
     writing nothing. Absent → throw `CompleteProviderLoginError("not-found", …)`, because
     `provider.register` consumed it. `completed` → return the stored result, because a
     concurrent caller completed the login. `pending` → throw
     `CompleteProviderLoginError("login-lost", …)`. Do not delete, and do not call
     `abortLogin`: a `lost` outcome proves the live entry was already absent, and the
     `loginId` is a ULID, so the call can never find one. Expiry and
     `provider.loginCancel` reap a row this arm leaves behind.
   - `{ status: "pending" }` → throw `CompleteProviderLoginError("login-pending", …)`. The
     row stays `pending` and nothing is written.
   - a thrown `LoginError` with `refusal === "code-required"` → throw
     `CompleteProviderLoginError("code-required", …)`; the row stays `pending`.
   - any other thrown `LoginError` → `"login-failed"`.
3. Resolve the model list, with no outbound call:

   ```ts
   const models =
     outcome.login.availableModelIds ??
     (
       dependencies.catalog.providers().find((p) => p.id === row.provider)
         ?.models ?? []
     ).map((model) => model.id);
   ```

   The login's own list wins when it carries one; the catalogue list is the fallback. Only
   the `github-copilot` flow supplies the first — see suggestion **S1** in the index.

4. Serialize and seal the payload:
   `crypto.seal(JSON.stringify({ credential: outcome.login.credential, models }))`.
   Key order is fixed by this literal, so the stored bytes are deterministic.
5. Transaction two:

   ```sql
   UPDATE provider_login
      SET state = 'completed', payload_ciphertext = ?, payload_iv = ?, payload_tag = ?, key_version = ?
    WHERE id = ? AND state = 'pending'
   ```

   Re-read the row afterwards inside the same transaction; if it is gone, throw
   `"not-found"`. The `AND state = 'pending'` guard makes a concurrent duplicate lose
   without corrupting the row.

6. Return `{ loginId, models }`.

The row is not deleted here. It is the idempotency record, and it survives until
`provider.register` consumes it or a cancel discards it.

### `src/commands/provider/cancel-provider-login.ts` (new file)

```ts
export type CancelProviderLoginDependencies = Readonly<{
  storage: Storage;
  providerAuth: ProviderAuth;
}>;

export type CancelProviderLoginInput = Readonly<{ loginId: string }>;
export type CancelProviderLoginRefusal = "not-found";
```

One transaction, and it returns `void`:

1. In the transaction: `SELECT id FROM provider_login WHERE id = ?`. `undefined` → return
   `{ kind: "not-found" }` and throw `CancelProviderLoginError("not-found", …)` after the
   commit.
2. `DELETE FROM provider_login WHERE id = ?` inside the transaction; return `{ kind: "ok" }`.
3. After the transaction commits, `dependencies.providerAuth.abortLogin(input.loginId)`.

Aborting after the commit is deliberate: a delete that rolls back must not leave the live
flow torn down while its row survives.

It applies to a `pending` row and a `completed` row alike. Cancelling a `completed` row
deletes it and discards the credential, because the human declined the registration. No
provider row is ever written by this command.

### Tests

Three new files, real SQLite through `createMigratedStorage()`, `AesGcmCrypto` with
`Buffer.alloc(32, 7)`, `createMockClock`, `createMockIdGenerator`,
`createFakeModelCatalog()`, and a hand-written `ProviderAuth` double recording every call.
Fixture ids: `LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X"`, so the login id is
`login_01HZY8QF3M4N5P6R7S8T9V0W1X`. Fixture credential
`{ type: "oauth", access: "at-1", refresh: "rt-1", expires: 1_700_000_600_000 }`.

**`src/commands/provider/start-provider-login.test.ts`**

1. `it("refuses a vendor with no oauth flow and calls the service no further")` — assert
   `provider-not-oauth-capable`, the double's `startLogin` never called, and zero rows.
2. `it("inserts one pending row and answers the device challenge")` — assert the result
   deep-equals `{ loginId, method: "device-code", expiresAt, userCode, verificationUri, pollIntervalMs }`
   by value, and that the row count is 1 with `state = 'pending'` and both payload columns
   `NULL`.
3. `it("answers the manual challenge and times its expiry from created_at")` — assert
   `expiresAt === createdAt + 600_000` by exact millisecond.
4. `it("takes the device expiry from the challenge, not from created_at")` — the double
   returns `expiresAt: 1_700_000_300_000` while `createdAt` is `1_700_000_000_000`; assert
   the stored `expires_at` is the challenge value.
5. `it("refuses a second start for the same vendor with login-in-progress")` — assert the
   refusal and that exactly one row exists.
6. `it("allows a start for a different vendor")` — assert two rows.
7. `it("refuses login-expired on an expired pending row, deletes it, and aborts")` —
   advance the mock clock past `expires_at`; assert the refusal, zero rows, and that the
   double recorded `abortLogin` with the old id. Then assert the following `start`
   succeeds.
8. `it("maps login-input-required with the exact prompt message in detail")` — the double
   throws `LoginError("login-input-required", …, "GitHub Enterprise URL/domain (blank for github.com)")`;
   assert the refusal and the exact `detail`, and assert zero rows.
9. `it("maps login-method-unavailable and writes no row")`.
10. `it("aborts and refuses login-in-progress when the insert loses the unique index")` —
    insert a competing pending row for the vendor between the pre-check and the insert by
    driving the command with a storage wrapper that inserts on first `transact`; assert
    `abortLogin` was called with the minted id.
11. `it("stores the running instance id")` — assert the column equals the injected
    `instanceId`.
12. `it("never stores or returns a token")` — assert the serialized result and the raw row
    bytes contain neither `"at-1"` nor `"rt-1"`.

**`src/commands/provider/complete-provider-login.test.ts`**

13. `it("answers not-found for an unknown loginId")`.
14. `it("completes a pending device login and stores the credential")` — assert the result
    `{ loginId, models }` by value, exactly one row, `state = 'completed'`, a non-null
    ciphertext, and that the fixture token values do not appear in the raw column bytes.
15. `it("refuses login-pending while the flow still polls and leaves the row pending")` —
    assert the refusal and `state = 'pending'`; then resolve the double and assert the next
    call completes and the row is `completed`.
16. `it("refuses code-not-accepted for a code on the device arm")` — assert the refusal,
    that `completeLogin` was never called, and that the row is unchanged.
17. `it("refuses code-required for an absent code on a suspended manual arm")`.
18. `it("completes a manual login the callback already resolved, with no code")`.
19. `it("passes the exact pasted code to the service")` — assert the double received
    `"abc-123"`.
20. `it("prefers the model ids the login returned")` — the double returns
    `availableModelIds: ["gpt-5-codex","gpt-5"]`; assert `models` deep-equals it and the
    catalogue was not consulted.
21. `it("falls back to the catalogue model ids")` — `availableModelIds: null`; assert
    `models` deep-equals the fake catalogue's ids for the vendor, by value.
22. `it("replays a completed login byte-identically")` — call twice, then a third time;
    assert all three results deep-equal, that `completeLogin` was called exactly once, and
    that every column of the row is byte-identical across the three calls.
23. `it("ignores a code supplied on a replay")` — assert the result is unchanged and no
    column moved.
24. `it("refuses login-expired on the first call after the deadline and not-found after")` —
    with the mock clock at exactly `expires_at` assert `login-expired`, zero rows, and
    `abortLogin` recorded; the next call answers `not-found`. Assert the boundary at
    `expires_at - 1` still completes.
25. `it("refuses login-lost when the stored instance is not the running one")` — assert the
    refusal and zero rows.
26. `it("refuses login-lost when the service has forgotten the flow")` — the double answers
    `{ status: "lost" }`; assert the refusal, and that the row is still present in state
    `pending` with a null payload. `it("returns the winner's stored result to a concurrent
loser")` and `it("leaves the pending row intact when the concurrent loser resolves
first")` — the double answers `{ status: "completed" }` to one call and
    `{ status: "lost" }` to the other, each resolved through a test-controlled deferred, and
    both `completeProviderLogin` calls start before either is awaited. Winner first: assert
    the loser's exact `{ loginId, models }`, one surviving row in state `completed` whose
    `payload_ciphertext` is byte-identical to the winner's seal, `completeLogin` called
    twice and `abortLogin` called zero times. Loser first: assert `login-lost`, the row
    still `pending`, then the winner's exact models, then a replay of those exact models.
    Order the calls by deferred only — never by a timer, a sleep, or microtask order.
27. `it("a successful complete leaves exactly one row in state completed")` — asserted by
    row count.

**`src/commands/provider/cancel-provider-login.test.ts`**

28. `it("cancels a pending login, aborts the flow and leaves zero rows")` — assert
    `abortLogin` recorded with the id and the row count is 0.
29. `it("cancels a completed login and writes no provider row")` — assert zero
    `provider_login` rows and zero `provider` rows.
30. `it("answers not-found for an unknown loginId")`.
31. `it("a start for the same vendor immediately after a cancel succeeds")` — the case
    `login-in-progress` otherwise refuses.
32. `it("is safe when the service has no live flow")` — the double's `abortLogin` is a
    no-op; assert no throw and zero rows.

Add these tests for the rollback trap and the ordering, in the files they belong to:

33. `it("the expired teardown survives the refusal")` (both command tests) — assert the row
    count is **zero** after the refusal, which fails if the delete and the throw share a
    transaction.
34. `it("expires a completed row on the same rule")` — a `completed` row past its deadline
    refuses `login-expired`, leaves zero rows, and the next call answers `not-found`.
35. `it("maps only a unique-constraint failure to login-in-progress")` — assert
    `isPendingLoginConflict` is true for the real conflict and false for an unrelated
    `StorageError`, and that an unrelated storage failure propagates unchanged.

## Constraints

- No `await` inside a `storage.transact` callback anywhere in the three files.
- **No refusal is thrown from inside a `transact` callback on a path that also deletes or
  writes.** The callback returns a marker; the command throws after the commit.
- `abortLogin` is called **after** the commit on every teardown path: expiry in both
  commands, `login-lost`, and cancel.
- Only a unique-constraint failure on `provider_login` maps to `login-in-progress`.
- `complete` never deletes a row it completed. Only expiry, `login-lost` and cancel delete.
- The replay path performs zero service calls and zero writes.
- The stored login payload is exactly `JSON.stringify({ credential, models })`, in that key
  order.
- No command appends an event. This epic adds one event type, and Story 6 owns it.
- No refusal message or `detail` carries a token, a code or a credential field.

## Verify

```
node --test \
  src/commands/provider/start-provider-login.test.ts \
  src/commands/provider/complete-provider-login.test.ts \
  src/commands/provider/cancel-provider-login.test.ts
npm run verify
```

Asserts all thirty-two cases above, including both expiry rules at an exact millisecond
boundary, the three-call replay with byte-identical columns and a single service call, the
row counts after complete and after cancel, and the absence of every fixture token value
from the raw row bytes.

Proof: delivers `src/commands/provider/start-provider-login.test.ts`,
`src/commands/provider/complete-provider-login.test.ts` and
`src/commands/provider/cancel-provider-login.test.ts` (PASS EPIC-045).
`npm run verify` exits 0.
