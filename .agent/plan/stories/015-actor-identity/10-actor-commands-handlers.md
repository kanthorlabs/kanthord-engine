# Story 10 — The actor commands and handlers

Epic: `.agent/plan/epics/015-actor-identity.md`
Depends on: Story 2, Story 3, Story 5, Story 9.

## Change

### The refusal type

- Create `src/commands/actor/refusal.ts` exporting `export class ActorCommandError extends Error` with a `readonly refusal` field over the closed union `"name-taken" | "no-configured-token" | "bootstrap-actor" | "actor-revoked" | "not-found"`. Follow the shape of `RegisterProviderError` in `src/commands/provider/register-provider.ts`.

### `src/commands/actor/register-actor.ts`

```ts
export type RegisterActorDependencies = Readonly<{
  storage: Storage;
  secret: Secret;
  ids: IdGenerator;
  events: EventLog;
  clock: Clock;
}>;

export type RegisterActorInput = Readonly<{
  name: string;
  actor: ActorRow;
  configuredToken: string;
}>;

export type RegisterActorResult = Readonly<{ view: ActorView; token: string }>;
```

Order of operations, all inside **one** `storage.transact`:

1. When `input.configuredToken === ""`, throw `ActorCommandError` with the refusal `"no-configured-token"` **before any write**. A local process must not mint a credential that outlives that mode.
2. `SELECT id FROM actor WHERE name = ?`. A row exists → throw the refusal `"name-taken"`. A revoked row still counts, because `name` is `UNIQUE`.
3. Mint `const id = ids.next("actor")` and `const value = secret.generate()`.
4. `INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, 'harness', ?, ?, ?, ?, NULL, NULL)` with `id`, `input.name`, `secret.digest(value)`, `input.actor.id` and `clock.now()`.
5. `events.append(transaction, { subjectKind: "actor", subjectId: id, type: "actor.registered", actorKind: input.actor.kind, actorId: input.actor.id, payload: { actorId: id, kind: "harness", name: input.name, registeredBy: input.actor.id } })`.
6. Return `{ view, token: renderActorToken({ actorId: id, secret: value }) }`.

**Registration creates a `harness` and nothing else.** The input carries no `kind`. The payload holds neither the secret nor its digest.

### `src/commands/actor/revoke-actor.ts`

Dependencies `{ storage, events, clock }`. Input `{ id, actor }`. Result `ActorView`. Inside one transaction:

1. Load the row by `input.id`. No row → refusal `"not-found"`.
2. `input.id === bootstrapActorId` → refusal `"bootstrap-actor"`.
3. When `revokedAt !== null`, return the existing view with no write and no event. **A second revoke returns the same view, so a retry is not an error.**
4. `UPDATE actor SET revoked_at = ?, revoked_by = ? WHERE id = ?` with `clock.now()` and `input.actor.id`.
5. **Lease fencing is vacuous in this epic, and the payload records that fact.** `lease` carries no `owner_kind` column until EPIC 018, so **no actor can own a lease today and there are no rows to fence**. Write `const leasesFenced = 0;` at this position in the sequence. This is a recorded count of rows that cannot exist, **not an implementation of the fencing rule** — EPIC 018 owns the implementation, and it replaces this expression with the real query when `lease.owner_kind` exists. Do **not** add a `lease` query and do not add a `lease` column here.
6. `events.append(..., type: "actor.revoked", payload: { actorId, kind, name, revokedBy: input.actor.id, revokedAt, leasesFenced })`.
7. Return the view.

An open execution record is not cancelled and not rewritten: its next report fails authentication.

### `src/commands/actor/rotate-actor-token.ts`

Dependencies `{ storage, secret, events, clock }`. Input `{ id, actor }`. Result `{ view: ActorView; token: string }`. Inside one transaction:

1. Load the row. No row → refusal `"not-found"`.
2. `input.id === bootstrapActorId` → refusal `"bootstrap-actor"`. Its secret lives in configuration and the daemon persists no digest for it.
3. `revokedAt !== null` → refusal `"actor-revoked"`. A rotation is not an undo.
4. Mint one new `value = secret.generate()`.
5. `UPDATE actor SET token_sha256 = ? WHERE id = ?`. **It writes no other column**, so `id`, `name`, `kind`, `registered_by`, `created_at` and every live lease survive.
6. `events.append(..., type: "actor.tokenRotated", payload: { actorId, kind, name, rotatedBy: input.actor.id, rotatedAt: clock.now() })`. The payload holds neither the token nor the digest.
7. Return the view and the rendered token.

### The queries

- `src/queries/actor/list-actor.ts` — dependencies `{ storage }`, input `{}`, result `readonly ActorView[]`. `SELECT ... FROM actor ORDER BY id ASC`. SQLite orders `TEXT` by `BINARY` collation by default, which is the bytewise order the epic requires. A revoked row **is** listed, and the view carries `revokedAt`.
- `src/queries/actor/show-actor.ts` — dependencies `{ storage }`, input `{ id }`, result `ActorView | null`.

### The handlers

Create the five files under `src/http/server/actor/`, following `src/http/server/credential/register-provider.ts` for a POST and `src/http/server/credential/list-provider.ts` for a GET: `register-actor.ts`, `list-actor.ts`, `show-actor.ts`, `revoke-actor.ts`, `rotate-actor-token.ts`. Each parses, invokes exactly one command or query, and formats. Each reads the calling actor from `context.actor` — **not** from a `dependencies.actor` string.

- `register-actor.ts` parses `actorRegisterRequest`, calls the command with `actor: context.actor`, and returns `{ status: 200, body: { ...result.view, token: result.token } }`.
- `rotate-actor-token.ts` reads `context.parameters.id`, parses no body, and returns the view plus the token.
- `revoke-actor.ts` reads `context.parameters.id` and returns the view.
- `show-actor.ts` returns `404 not-found` when the query returns `null`.
- `list-actor.ts` returns `{ actors: [...] }`.
- Create `src/http/server/actor/refusals.ts` exporting `toHttpError(error: unknown): HttpError`, following `src/http/server/credential/refusals.ts:14-18`. It maps every `ActorCommandError` refusal except `"not-found"` to `httpError("invalid-request", error.message, { refusal: error.refusal })`, and maps `"not-found"` to `httpError("not-found", error.message)`.

  **`404` for an unknown actor id is derived from precedent, not chosen.** Every id-addressed operation in the repository already answers `404 not-found` for an absent row, and the actor commands copy that shape exactly:

  | precedent                                                   | mechanism                                                                                                                                                                                                                                                                                          |
  | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `provider.rename`, `provider.remove`, `provider.setDefault` | a command-level `"not-found"` refusal with the message `` `no provider ${input.id}` `` (`src/commands/provider/rename-provider.ts:62`, `remove-provider.ts:64`, `set-default-provider.ts:70`), mapped to `httpError("not-found", …)` at `src/http/server/credential/refusals.ts:21-22,35-36,43-44` |
  | `provider.show`, `project.show`, `repository.show`          | `httpError("not-found", …)` thrown in the handler (`src/http/server/credential/show-provider.ts:22`, `project/show-project.ts:19`, `repository/show-repository.ts:21`)                                                                                                                             |

  `provider.rename` is the closest parallel: its refusal union is `"not-found" | "name-taken"` (`src/commands/provider/rename-provider.ts:25`), and it maps `not-found` to `404` and `name-taken` to `400`. The actor commands carry the same pair and take the same mapping. Use the message shape `` `no actor ${input.id}` ``. Answering `400` here would make the actor routes the only id-addressed operations in the contract that disagree with every sibling.

  The disclosure is already accepted: `015-actor-identity.md:29` makes an actor id public by construction and `actor.list` returns every id, so a `404` reveals nothing the contract does not already publish.

## Constraints

- The state change and its event append never sit in two transactions. Every command opens exactly one `storage.transact` and passes the context to `events.append`.
- `src/commands/` and `src/queries/` import no vendor package and reach every capability through a service interface.
- A handler branches on no domain rule. Each throws through `toHttpError` and decides nothing itself.
- The configured-token refusal is checked **inside** the transaction, before any write, so the `actor` table is byte-identical after it.
- `actor.rotate` admits a `human` caller only and targets a registered `harness` row; Story 7's registry data enforces the caller kind, so the command does not recheck it.
- Add no `--print-token` path and no stdout disclosure anywhere in this story.

## Verify

Create the test files below. Use **real SQLite** through `createMigratedStorage()`, the real `NodeCryptoSecret`, `createMockClock` and `createMockIdGenerator`, following `src/commands/provider/register-provider.test.ts`. Read rows and events back with direct `SELECT` inside `storage.transact`.

- `src/commands/actor/register-actor.test.ts`:
  - A registration writes exactly one row with `kind === "harness"`, `registered_by` equal to the caller id, `revoked_at` null, and a 32-byte `token_sha256` equal to `secret.digest(<returned secret half>)`.
  - The returned `token` matches the whole-token pattern, its id half equals the new row id, and `parseActorToken` round-trips it.
  - Exactly one `actor.registered` event exists. Its `actor_id` is the caller id and its parsed payload keys deep-equal `["actorId", "kind", "name", "registeredBy"]` sorted — asserting **no** `token` and **no** digest key.
  - `configuredToken: ""` throws the refusal `"no-configured-token"`, and `tableCounts(storage)` is deep-equal before and after.
  - A duplicate name throws `"name-taken"`, including when the existing row is revoked.
  - A name outside `actorNamePattern` is **not** the command's concern; assert the command accepts it, because `actorRegisterRequest` refuses it at the boundary.
- `src/commands/actor/revoke-actor.test.ts`:
  - A revoke stamps `revoked_at` and `revoked_by`, and appends exactly one `actor.revoked` event whose payload `revokedBy` is the caller id and whose `leasesFenced` is `0`.
  - A second revoke returns the same view, writes nothing and appends no second event, asserted by an event count of 1.
  - Revoking `bootstrapActorId` throws `"bootstrap-actor"`, and **both** the `actor` and `event` tables are byte-identical before and after.
  - An unknown id throws `"not-found"`.
  - **A rolled-back revocation leaves no event.** Drive it with an `events` Mock whose `append` throws, assert the throw, then assert `revoked_at` is still null and the event count is unchanged.
- `src/commands/actor/rotate-actor-token.test.ts`:
  - Rotation writes a new `token_sha256` that differs from the old one, and leaves `id`, `name`, `kind`, `registered_by` and `created_at` byte-identical, asserted **column by column** against the pre-rotation row.
  - The returned token differs from the registered one and its id half is unchanged.
  - Exactly one `actor.tokenRotated` event exists; its payload keys deep-equal `["actorId", "kind", "name", "rotatedAt", "rotatedBy"]` sorted, asserting no `token` and no digest key; `rotatedBy` is the caller id.
  - A rolled-back rotation leaves no event **and leaves the original digest**, driven by a throwing `events` Mock.
  - Rotating `bootstrapActorId` throws `"bootstrap-actor"`; rotating a revoked actor throws `"actor-revoked"`. Both leave `actor` and `event` byte-identical.
  - **A rotation preserves a lease the actor owns.** Insert a `lease` row directly, rotate, and assert every `lease` row is byte-identical. This separates rotation from revocation.
- `src/queries/actor/list-actor.test.ts`: with three registrations against a Mock id generator yielding ascending ULIDs, `listActor` returns **four** views — the bootstrap row **first**, then the three in ascending bytewise id order. Assert the id list with `deepEqual`. `bootstrapActorId` sorts first because twenty-six `0` characters precede every real ULID. A revoked row is present and its view carries a non-null `revokedAt`.
- `src/queries/actor/show-actor.test.ts`: a known id returns the view with no `token` key and no `tokenSha256` key, asserted over `Object.keys`. An unknown id returns `null`.
- `src/http/server/actor/*.test.ts`, one file per handler, built through `createTestApp` with the handler bound and `resolveActor` overridden to the bootstrap human fixture:
  - `POST /v1/actor` with a valid body answers `200` and the body carries `token` once.
  - A body carrying `kind` answers `400 invalid-request`.
  - An uppercase name, a leading-hyphen name and a 64-character name each answer `400 invalid-request`.
  - A registration under an empty configured token answers `400` with `details.refusal === "no-configured-token"`.
  - A duplicate name with no `Idempotency-Key` answers `400` with `details.refusal === "name-taken"`.
  - `POST /v1/actor/<bootstrapActorId>/revoke` answers `400` with `details.refusal === "bootstrap-actor"`; the same for `/rotate`.
  - `POST /v1/actor/<revoked id>/rotate` answers `400` with `details.refusal === "actor-revoked"`.
  - `GET /v1/actor/<unknown>` answers `404`, and its message is `` `no actor <id>` ``. `POST /v1/actor/<unknown>/revoke` and `POST /v1/actor/<unknown>/rotate` each answer `404` with the same message shape, matching `provider.rename` and `provider.remove`.
  - **A replay of `actor.register` under the same `Idempotency-Key`** returns the byte-identical body, and the `actor` table holds exactly one new row. **A replay of `actor.rotate` under the same key** returns the byte-identical body and therefore the same token, and the stored digest changed exactly once. A second `actor.rotate` with a **new** key mints a third token.
  - Every response body of `actor.list` and `actor.show` holds no `token` key.
- Run `node --test --test-timeout=60000 src/commands/actor/*.test.ts src/queries/actor/*.test.ts src/http/server/actor/*.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 114, 116, 118, 119, 121, the command half of 122, and 128, 129, 130, 131, 133.
