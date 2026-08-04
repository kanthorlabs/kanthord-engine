# Story 04 — The credential routes, both kinds

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 03 (`parsePayload`, `serializePayload`, `projectPayload`), EPIC 004 Story 01 (`createApp`, `Handler`, `createTestApp`).

`provider.register`, `provider.list` and `provider.show`, on the crypto service of EPIC 003. Three routed operations gain schemas, one command, two queries and three handlers. The secret is write-only.

This story creates `src/commands/` and `src/queries/` for the first time. Both are already declared in `eslint.config.js:43-44`, so no configuration change is needed.

## Change

### 1. `src/http/contract/credential.ts` — schemas on the three phase-1 operations

Import the payload schemas from `src/domain/provider-payload.ts` and add `request`, `response` and nothing else to the three `routed` entries. The three `stubbed` entries (`:26-46`) are unchanged and carry no schema; `docs/proposal/api/README.md:54` gives them a `501` and no body.

```ts
export const providerRegisterRequest = z.object({
  name: z.string().min(1),
  kind: z.enum(providerKinds),
  payload: z.unknown(),
});

export const providerView = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(providerKinds),
  projection: providerProjection,
  setDefaultAt: z.number().nullable(),
  updatedAt: z.number(),
});

export const providerRegisterResponse = providerView;
export const providerListResponse = z.object({
  providers: z.array(providerView),
});
export const providerShowResponse = providerView;
```

`payload` is `z.unknown()` in the transport schema, and Story 03's `parsePayload` is what validates it. The kind is the dispatch key, so a transport-level schema cannot know the payload shape until it has read `kind` — a `z.discriminatedUnion` on `kind` here would duplicate the factory the proposal puts in one place (`docs/proposal/database/provider.md:25`).

No entry gains `successStatus`. The proposal declares no created-resource status, and `src/http/contract/openapi.ts` defaults an absent `successStatus` to `200`. Adding a `201` would be a contract decision this epic has no source for.

### 2. `src/commands/provider/register-provider.ts` (new)

```ts
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  parsePayload,
  serializePayload,
  projectPayload,
  type ProviderKind,
} from "../../domain/provider-payload.ts";

export type RegisterProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
}>;

export type RegisterProviderInput = Readonly<{
  name: string;
  kind: ProviderKind;
  payload: unknown;
  actor: string;
}>;

export type ProviderView = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  projection: ProviderProjection;
  setDefaultAt: number | null;
  updatedAt: number;
}>;

export type RegisterProviderRefusal = "name-taken";

export class RegisterProviderError extends Error {
  readonly refusal: RegisterProviderRefusal;
  constructor(refusal: RegisterProviderRefusal, message: string);
}

export function registerProvider(
  dependencies: RegisterProviderDependencies,
  input: RegisterProviderInput,
): ProviderView;
```

The function is **synchronous**. `Storage.transact` is synchronous (`src/services/storage/index.ts:33`) and `Crypto.seal` is synchronous (`src/services/crypto/index.ts:21`), and `src/services/storage/connection.ts:90-101` rolls back and throws on a returned promise.

Sequence, in this order:

1. `parsePayload(input.kind, input.payload)`. A `PayloadError` propagates unchanged; Story 04's handler maps it.
2. `serializePayload(input.kind, parsed)` and `dependencies.crypto.seal(text)`.
3. `dependencies.ids.mint("provider")` and `dependencies.clock.now()`.
4. `storage.transact` once. Inside it:
   - `SELECT id FROM provider WHERE name = ?`. A row throws `RegisterProviderError("name-taken", `a provider named ${input.name} is already registered`)`, which rolls the transaction back.
   - `INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?,?,?,?,?,?,?,?,?)` with `set_default_at` `null`.
   - `events.append(transaction, { subjectKind: "provider", subjectId: id, type: "provider.registered", actorKind: "human", actorId: input.actor, payload: { name, kind } })`.
5. Return the view, whose `projection` is `projectPayload(input.kind, parsed)`.

`set_default_at` is always `null`. `docs/proposal/database/provider.md:94` keeps the git chain empty, and `docs/proposal/api/credential.md:50` gives the stamp to `provider.setDefault`, which is `stubbed` in this phase. A registration therefore never stamps its own default, for either kind.

The event payload names `name` and `kind` and **never** the payload. An event row is plaintext.

### 3. `src/queries/provider/list-provider.ts` (new)

```ts
export type ListProviderDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
}>;
export type ListProviderInput = Readonly<{ kind?: ProviderKind }>;
export type ProviderListItem = ProviderView | BrokenProviderView;
export type BrokenProviderView = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  projection: null;
  setDefaultAt: number | null;
  updatedAt: number;
}>;
export function listProviders(
  dependencies: ListProviderDependencies,
  input: ListProviderInput,
): readonly ProviderListItem[];
```

One statement, columns named, never `*`:

```sql
SELECT id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at
FROM provider
ORDER BY id ASC
```

`ORDER BY id ASC` is the order. A provider id carries a ULID, whose prefix is monotonic, so registration order is recovered without a timestamp column. `provider` has no index beyond its primary key and its unique name, so the sort is on the primary key and the order is total.

`input.kind` appends `WHERE kind = ?` before the `ORDER BY`. The two forms are two literal statement strings, not a concatenation, so a filter cannot alter the projection list.

A row whose payload fails `crypto.open` or `deserializePayload` yields a `BrokenProviderView` with `projection: null`. `docs/proposal/database/provider.md:63` requires a registration whose payload cannot be decrypted to be reportable rather than absent.

### 4. `src/queries/provider/show-provider.ts` (new)

```ts
export type ShowProviderInput = Readonly<{ id: string }>;
export function showProvider(
  dependencies: ListProviderDependencies,
  input: ShowProviderInput,
): ProviderListItem | null;
```

The same column list with `WHERE id = ?`. An absent row returns `null`.

### 5. `src/http/server/credential/` (new) — three handlers

`register-provider.ts`, `list-provider.ts`, `show-provider.ts`. Each exports one factory returning a `Handler` from `src/http/server/app.ts`:

```ts
export type RegisterProviderHandlerDependencies = Readonly<{
  registerProvider: (input: RegisterProviderInput) => ProviderView;
  actor: string;
}>;
export function registerProviderHandler(
  dependencies: RegisterProviderHandlerDependencies,
): Handler;
```

Each handler parses, invokes exactly one command or query, and formats. It branches on no domain rule.

The mapping from a thrown refusal to an `HttpError` is one shared function so no handler carries a table:

`src/http/server/credential/refusals.ts` (new):

```ts
export function toHttpError(error: unknown): HttpError;
```

| thrown                                | `httpError` call                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `PayloadError` any refusal            | `httpError("invalid-request", error.message, { refusal: error.refusal, detail: error.detail })` |
| `RegisterProviderError("name-taken")` | `httpError("invalid-request", error.message, { refusal: "name-taken" })`                        |
| anything else                         | rethrown unchanged                                                                              |

`name-taken` is `400 invalid-request` and not `409 binding-in-use`. `docs/proposal/api/README.md:154` gives `binding-in-use` to a refused **removal**, and `errors.ts:58` makes `details` mandatory for every `409`; a unique-name collision is a body that fails validation against existing state, which is what `invalid-request` names. `docs/proposal/api/credential.md:32` says only that the name is unique and declares no code for the collision.

`show-provider.ts`'s handler answers `httpError("not-found", `no provider ${id}`)` on a `null` query result.

`list-provider.ts`'s handler reads no query parameter. `docs/proposal/api/credential.md:18` gives the CLI a `provider.list` it filters client-side, and the registry declares no query-parameter mechanism.

### 6. `src/main.ts` — bind three handlers

Add the three entries to the `handlers` record EPIC 004 Story 01 passes to `createApp`. The `unimplemented` filter (`.agent/plan/stories/004-transport-skeleton/01-server-bootstrap.md:158-162`) shrinks by three with no edit, because it is derived.

`main.ts` constructs `new AesGcmCrypto({ key: settings.masterKey, keyVersion: 1 })`, `new SqliteEventLog({ storage, ids })`, and binds `actor: settings.actor`.

### 7. Contract tests that pin counts

Three existing assertions become false and each has one deterministic replacement.

- `src/http/contract/registry.test.ts:66-72` asserts every entry has `request === undefined && response === undefined`. Replace with: the set of `operationId` values carrying a `request` deep-equals `["provider.register"]`, and the set carrying a `response` deep-equals `["provider.list","provider.register","provider.show"]`, both bytewise sorted. Later stories extend both lists, and the final values are pinned in Story 11.
- `src/http/contract/openapi.test.ts:202` asserts `components.schemas` keys are exactly `["Error"]`. Replace with a deep-equal against the bytewise-sorted list `["Error","provider.list.response","provider.register.request","provider.register.response","provider.show.response"]`.
- `src/http/contract/openapi.test.ts:190-193` asserts no entry sets `successStatus`. It stays green, because this story sets none. State that in the story so the next author does not add one.

`src/http/contract/parity.test.ts` and the registry counts (`53` entries, `23` routed, `30` stubbed) are unchanged. This story adds no operation and edits no path, so `docs/proposal/api/credential.md`'s table needs no edit and `src/http/contract/path.ts` gains no segment.

## Constraints

- `src/commands/**` and `src/queries/**` import no vendor package, no `node:sqlite` and no `node:fs`, enforced by `eslint.config.js:210-234`. Every effect arrives through a service interface.
- No query selects `*`. `docs/proposal/database/provider.md:61` requires named columns so a ciphertext cannot reach a log by accident.
- No route reads a credential field back. `ProviderView` has no member that can carry one, and `projectPayload` builds a fresh literal.
- The command opens exactly one transaction, and the event append shares it. `Storage.transact` does not nest (`src/services/storage/sqlite.ts:37`).
- The plaintext payload never reaches an event, a log or a `RegisterProviderError` message.
- `provider.setDefault` is not implemented here. It is `stubbed` and answers `501` through `dispatchMiddleware`, so its `kind = 'git'` refusal has no code path in this phase — see the epic open items.
- No handler branches on a domain rule. Each one parses, calls one function, and formats.

## Verify

`node --test src/commands/provider/register-provider.test.ts src/queries/provider/list-provider.test.ts src/queries/provider/show-provider.test.ts src/http/server/credential/register-provider.test.ts src/http/server/credential/list-provider.test.ts src/http/server/credential/show-provider.test.ts src/http/contract/registry.test.ts src/http/contract/openapi.test.ts`

Every command and query test uses `createMigratedStorage()` from `test/helpers/database.ts`, `createMockIdGenerator({ ulids })` from `test/helpers/ids.ts`, `createMockClock({ start: 1700000000000, step: 1000 })` from `test/helpers/clock.ts`, and `new AesGcmCrypto({ key: Buffer.alloc(32, 7), keyVersion: 1 })`. A Mock is used, not a Fake, because the stories below name the values.

### `src/commands/provider/register-provider.test.ts`

- A `git` / `http-basic` registration inserts one row. Read it back with a named-column select and assert: `id` equals `` `provider_${ulids[0]}` ``, `name`, `kind === "git"`, `set_default_at === null`, `key_version === 1`, `updated_at === 1700000000000`, `length(payload_iv) === 12`, `length(payload_tag) === 16`.
- The returned view deep-equals `{ id, name, kind: "git", projection: { transport: "http-basic", forge: "github", username: "kanthord-bot" }, setDefaultAt: null, updatedAt: 1700000000000 }`.
- **The ciphertext holds the canonical bytes.** `crypto.open` of the three stored columns equals `serializePayload("git", parsed)` exactly.
- **The token is nowhere in plaintext.** Assert the stored `payload_ciphertext` as a `latin1` string does not include the token; assert the `event` row's `payload_json` does not include it; assert the returned view serialized with `JSON.stringify` does not include it.
- An `llm` registration writes `kind === "llm"` and returns the llm projection.
- **`set_default_at` stays null for an `llm` registration too.** Asserted directly, because `docs/proposal/database/provider.md:69` says onboarding stamps one and `provider.setDefault` owns the stamp.
- Exactly one `event` row exists, with `subject_kind === "provider"`, `subject_id` equal to the minted id, `type === "provider.registered"`, `actor_kind === "human"`, `actor_id` equal to the input actor, and `payload_json` equal to `{"name":"…","kind":"git"}` byte for byte.
- **A duplicate name refuses and writes nothing.** Register once, then register again with the same name. The second call throws `RegisterProviderError` with `refusal === "name-taken"`. Then assert `SELECT COUNT(*) FROM provider` is `1` and `SELECT COUNT(*) FROM event` is `1`. The rollback is proved by state, not by the throw.
- **An invalid payload refuses before it reaches storage.** A `git` payload with `forge: "codeberg"` throws `PayloadError` with `refusal === "payload-invalid"`, and both table counts are `0`. Assert also that `ids.mint` was never called, by supplying a generator with an empty `ulids` array and asserting the error is the `PayloadError` rather than `ids-exhausted`.
- **An encrypted ssh key refuses at registration.** A `{ transport: "ssh", privateKey: <passphrase key> }` payload throws `PayloadError` with `refusal === "private-key-encrypted"`, and no row exists. This is the epic coverage line "refused … when the key is encrypted", on the registration side.

### `src/queries/provider/list-provider.test.ts`

- Three registrations return three items in ascending `id` order, asserted against the exact minted id list. Reverse the insertion order of the names and assert the returned order is unchanged — the order is the id, not the name and not insertion.
- Every item carries a `projection` and no credential field, asserted with `Object.hasOwn` on `apiKey`, `token` and `privateKey` for each item.
- `{ kind: "git" }` returns only the git rows, in the same order.
- **A broken payload is reported, not dropped.** After a registration, overwrite `payload_tag` with sixteen zero bytes through a direct `transact` write. `listProviders` returns one item whose `projection` is `null`, whose `id`, `name` and `kind` are intact, and the call does not throw. This is `docs/proposal/database/provider.md:63`.
- An empty table returns `[]`.
- **The statement names its columns.** Assert by construction: read the module source with `fs.readFileSync(new URL("./list-provider.ts", import.meta.url))` and assert it contains no `"SELECT *"` and no `"select *"`. The rule has no runtime signal, so this is the mechanism.

### `src/queries/provider/show-provider.test.ts`

- A registered id returns the view, field by field.
- An unknown but well-formed id `provider_01HZY8QF3M4N5P6R7S8T9V0W1X` returns `null`.
- A broken payload returns `projection: null`.
- **Each kind returns that kind's projection, asserted field by field.** Register one `llm` and one `git` / `http-basic` and one `git` / `ssh`. For each, `assert.deepEqual(Object.keys(view.projection).sort(), …)` against `["baseUrl","defaultModel","provider"]`, `["forge","transport","username"]` and `["forge","transport","username"]`, and assert every value. Then assert `Object.hasOwn(view.projection, "apiKey")`, `"token"` and `"privateKey"` are all `false`. This is the epic coverage line "asserted field by field rather than by a substring search".

### The three handler tests

Each uses `createTestApp({ handlers: { … } })` from `test/helpers/app.ts` with a hand-written stub for the single command or query, and asserts status, body and that the stub was called exactly once with the parsed input.

- `POST /v1/provider` with a valid body answers `200` and the view.
- `POST /v1/provider` with `{}` answers `400` with `error.code === "invalid-request"`.
- A stub throwing `PayloadError("private-key-encrypted", …)` yields `400`, `error.code === "invalid-request"`, and `error.details.refusal === "private-key-encrypted"`.
- A stub throwing `RegisterProviderError("name-taken", …)` yields `400` with `error.details.refusal === "name-taken"`.
- `GET /v1/provider` answers `200` with `{ providers: [...] }`.
- `GET /v1/provider/provider_01HZY8QF3M4N5P6R7S8T9V0W1X` with a `null` stub answers `404` with `error.code === "not-found"`.
- `PUT /v1/provider/<id>/default` answers `501` with a message ending in `"ships in phase-2"`, and the test asserts the database is untouched by comparing a `SELECT COUNT(*) FROM provider` before and after. This is the `AGENTS.md` rule "a `stubbed` route answers 501 and writes nothing".
- No handler test asserts a domain rule. Each stub is the domain.

### E2E — scenario `E7-04`

File `scripts/e2e/007/04-credential-routes.e2e.ts`. It drives the **real daemon over HTTP** with the **real GitHub token** as the registered credential.

- Boot a daemon with `launchDaemon` from `test/helpers/daemon.ts` against a `createTemporaryHome()` whose config names the probed tools, then `await daemon.ready()`.

  The harness may import `test/helpers/daemon.ts`: `scripts/` is outside the boundaries block, and reusing the launcher avoids a second daemon-spawning mechanism. Story 02's constraint against importing `test/` is therefore relaxed for `daemon.ts` and `home.ts` alone, and Story 02's constraint list names those two.

- `POST /v1/provider` with `{ name: "e2e-github", kind: "git", payload: { transport: "http-basic", forge: "github", username: "x-access-token", token: env.ghToken } }` answers `200`.
- The response body's `projection` deep-equals `{ transport: "http-basic", forge: "github", username: "x-access-token" }`, and `JSON.stringify(body)` does not include `env.ghToken`.
- `GET /v1/provider` includes the registration, and no item's serialized form includes `env.ghToken`.
- `GET /v1/provider/<the returned id>` answers `200` and the same projection, field by field.
- **The stored row really is encrypted.** Read `<home>/kanthord.db` directly with `node:sqlite` after the daemon exits and assert `payload_ciphertext` as a `latin1` string does not include `env.ghToken`, while `crypto.open` of the three columns with the config's master key does. The daemon is stopped first, because the home lock is exclusive.
- Registering the same name twice answers `400` with `error.details.refusal === "name-taken"`, and `GET /v1/provider` still reports one registration.
- **A registration with the real token but an encrypted ssh key is refused.** Generate a passphrase-protected key in the scenario's temporary directory and assert `400` with `error.details.refusal === "private-key-encrypted"`.
- The scenario creates no remote ref and makes no call to GitHub. It proves the credential route end to end with the credential the rest of the gate uses, which is what makes the later scenarios' `credentialId` real.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/commands/provider/register-provider.test.ts`, `src/queries/provider/list-provider.test.ts` and `src/queries/provider/show-provider.test.ts` to the epic Proof globs `src/commands/provider/**/*.test.ts` and `src/queries/provider/**/*.test.ts`.
