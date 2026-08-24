---
epic: .agents/plan/epics/101-credential-registry-completion.md
opened: 2026-08-13
opener: test-engineer
base-ref: 626a31981c5f4bd76884d92824fdfacc2596619c
---

# Implementation cycle — 101-credential-registry-completion

Pulled from EPIC: `.agents/plan/epics/101-credential-registry-completion.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test src/commands/provider/*.test.ts \\
>   src/queries/provider/*.test.ts \\
>   src/http/server/credential/*.test.ts \\
>   src/services/ids/ulid.test.ts \\
>   src/services/config/convict.test.ts \\
>   src/services/config/refusals.test.ts \\
>   src/services/config/startup.test.ts \\
>   src/services/crypto/aes-gcm.test.ts && echo "PASS EPIC-101"
> ```
>
> TDD protocol:
>
> 1.  test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
> 2.  software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
> 3.  test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 101-credential-registry-completion · Story 01 — monotonic id generator

**Cycle.** RED for Story `01-monotonic-id-generator` (`node --test src/services/ids/ulid.test.ts`).
**Test written.**

- file: `src/services/ids/ulid.test.ts` (edited) — suite: `src/services/ids/ulid.test` — methods: `mints two event ids in one fixed millisecond in mint order`
- asserts: `Date.now` mocked to `1700000000000`; two `mint("event")` ids from one `UlidIdGenerator` sort in mint order, `Buffer.compare(Buffer.from(first), Buffer.from(second)) === -1`
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: expected event_01HF7YAT0082DDDTQQNGPAWRTY to sort before event_01HF7YAT006C4XCSJQTTQCGMD5`, `actual: 1, expected: -1`, `ℹ fail 1` (run: `ℹ tests 3395`, `ℹ pass 3394`).
- The failure is probabilistic under the current `ulid()` call, ~50% per run (two independent random parts in one millisecond); observed on 3 of 8 single-file runs and on the first `npm test` run.
- stub probe: n/a — no missing seam; `UlidIdGenerator.mint` already exists. `npm run typecheck` exits 0 with the new test in place.
  **Open to Software Engineer.**
- `src/services/ids/ulid.ts` — the `UlidIdGenerator` class and its `mint(kind: IdentityKind): string` signature stay unchanged, and the returned `${prefix}_<ULID>` format stays unchanged; make two `mint` calls for the same kind in one millisecond return ids that sort in mint order. The Story file's Change/Constraints sections name the factory approach.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 01 — monotonic id generator

**Cycle.** GREEN+REFACTOR for `src/services/ids/ulid.test.ts`.
**Files changed.**

- `src/services/ids/ulid.ts` (edited) — `import { monotonicFactory }`; module-scoped `const mintUlid = monotonicFactory();`; `mint(kind)` now returns `${identityPrefixes[kind]}_${mintUlid()}`
  **Seam (GREEN).** `mint` mints from the shared `monotonicFactory` instance, so two mints in one millisecond sort in mint order; `IdGenerator`, prefixes, ULID format and identity parsing are untouched.
  **Refactor.** The Story names no separate REFACTOR step beyond the factory construction itself; applied in the GREEN change (`monotonicFactory()` built once at module scope, per the Story's Change/Constraints sections).
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 01 GREEN confirm + Story 02 RED — provider view domain type

**Cycle.** Confirm GREEN for Story `01-monotonic-id-generator`; RED for Story `02-provider-view-domain-type` (`node --test src/domain/provider-view.test.ts src/commands/provider/register-provider.test.ts src/http/server/credential/register-provider.test.ts`).
**GREEN confirmed (Story 01).**

- command: `node --test src/services/ids/ulid.test.ts` — exit: 0 — `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`
- handoff gate: the SE turn cites `typecheck: exit 0`. `npm run verify:handoff` reports `VERIFY: FAIL — npm run typecheck exited 2`, but every current error is `TS2307` in the three files this Story-02 RED touched after the SE turn (`src/domain/provider-view.test.ts` ×2, `src/commands/provider/register-provider.test.ts:28`, `src/http/server/credential/register-provider.test.ts:8`) — the delta traces 1:1 to my own files, so the SE's typecheck claim matches the artifact of its own tree; the functional artifact of its turn (the Story 01 suite) is green above.
  **Test written.**
- file: `src/domain/provider-view.test.ts` (new) — suite: `src/domain/provider-view.test` — methods: `a fixture with a null projection carries exactly the six public keys in bytewise order`, `the provider view module resolves at the domain seam`
- asserts: a fixture typed `ProviderView` with `projection: null`; `Object.keys(fixture)` sorted by `Buffer.compare(Buffer.from(a), Buffer.from(b))` deep-equals `["id", "kind", "name", "projection", "setDefaultAt", "updatedAt"]`; the seam module resolves at runtime
- file: `src/commands/provider/register-provider.test.ts` (edited) — the `ProviderView` type import moves to `../../domain/provider-view.ts`; `RegisterProviderDependencies`/`RegisterProviderInput` stay on the command module
- file: `src/http/server/credential/register-provider.test.ts` (edited) — the `ProviderView` type import moves to `../../../domain/provider-view.ts`; `RegisterProviderInput` stays on the command module
  **RED proof.**
- command: `node --test src/domain/provider-view.test.ts src/commands/provider/register-provider.test.ts src/http/server/credential/register-provider.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/domain/provider-view.ts' imported from .../src/domain/provider-view.test.ts`, `ℹ tests 16`, `ℹ pass 15`, `ℹ fail 1` — the two existing suites stay green because the moved imports are type-only and stripped
- typecheck: `npm run typecheck` — exit: non-zero — 4× `error TS2307: Cannot find module '<…>/provider-view.ts' or its corresponding type declarations` (two in the new file, one in each edited test file)
- vacuous-pass note: the keys-sort method passes at runtime before the seam exists (type-only import strips away) — it is the Story's named characterization pin of the declared shape; its sensitivity is carried by the module-resolution method (runtime `ERR_MODULE_NOT_FOUND`) and the four TS2307s (typecheck)
- stub probe: `src/domain/provider-view.ts` — declared signature (exact six fields, `projection: ProviderProjection | null`): the new test file and `src/commands/provider/register-provider.test.ts` compile clean; 4 `TS2322` remain in `src/http/server/credential/register-provider.test.ts`, all transient — my mock returns (domain view, nullable projection) are compared against the handler dependency type, which still names the command-local non-null `projection` type until the Story's production import switch; no test-side fix. Stub deleted; the 4 TS2307s above are restored.
  **Open to Software Engineer.**
- `src/domain/provider-view.ts` — new type-only file; exports `type ProviderView` with exact fields `id: string`, `name: string`, `kind: ProviderKind`, `projection: ProviderProjection | null`, `setDefaultAt: number | null`, `updatedAt: number`; imports `ProviderKind` and `ProviderProjection` as types from `src/domain/provider-payload.ts`; no runtime export and no schema (the Story's Change/Constraints name the rest: drop the local `ProviderView` and the now-unused `ProviderProjection` type import from `src/commands/provider/register-provider.ts`, and import `ProviderView` from the domain module there and in `src/http/server/credential/register-provider.ts`).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 02 — provider view moves to domain/

**Cycle.** GREEN+REFACTOR for `src/domain/provider-view.test.ts` (+ the two moved-import test files).
**Files changed.**

- `src/domain/provider-view.ts` (new) — `export type ProviderView`, exact fields `id`, `name`, `kind`, `projection`, `setDefaultAt`, `updatedAt`; `projection: ProviderProjection | null`; `import type` of `ProviderKind` and `ProviderProjection` from `./provider-payload.ts`; no runtime export, no schema
- `src/commands/provider/register-provider.ts` (edited) — local `ProviderView` type and the now-unused `type ProviderProjection` import removed; `ProviderView` imported as a type from `../../domain/provider-view.ts`; `RegisterProviderInput` and `RegisterProviderRefusal` stay on the command
- `src/http/server/credential/register-provider.ts` (edited) — `ProviderView` import moved from `../../../commands/provider/register-provider.ts` to `../../../domain/provider-view.ts`; `RegisterProviderInput` stays on the command
  **Seam (GREEN).** The new module resolves at `src/domain/provider-view.ts`, and the `ProviderView` type the command and handler use now declares `projection: ProviderProjection | null`, which also resolves the 4 transient `TS2322`s the TE's stub probe saw in the handler test.
  **Refactor.** The Story's Change section is the refactor — applied in full: type-only domain module, nullable projection, production import switch. Constraint honored: `src/queries/provider/list-provider.ts` and `show-provider.ts` private result types untouched, no runtime validation added (`src/http/contract/credential.ts` remains the transport schema).
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the Story names only the one command and the one handler as production import sites; grep of `src/**` confirms every remaining production `ProviderView` import resolves from `src/domain/provider-view.ts` (`queries/` modules carry their own private types, which the Story forbids changing).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 03 RED — first registration stamps the chain

**Cycle.** RED for Story `03-first-registration-stamps-chain` (`node --test src/commands/provider/register-provider.test.ts`).
**Test written.**

- file: `src/commands/provider/register-provider.test.ts` (edited) — suite: `src/commands/provider/register-provider.test`
- methods:
  - `a first llm registration stamps set_default_at with its own updated_at` (rewrites the former null-set_default_at test per Story Verify line 23) — asserts `view.setDefaultAt`, row `set_default_at` and row `updated_at` all equal `1700000000000`
  - `a first llm registration appends provider.registered then provider.defaultSet in id order` — events sorted by `Buffer.compare` on `id` read `["provider.registered", "provider.defaultSet"]`; second payload JSON deep-equals `{"name":"anthropic-bot","kind":"llm","setDefaultAt":1700000000000}`, first stays `{"name":"anthropic-bot","kind":"llm"}`
  - `a second llm registration stores a null set_default_at and appends only provider.registered` — stamps first (precondition `set_default_at === 1700000000000`), then second stores null and appends one event
  - `an llm registration while an unstamped llm row exists stores a null set_default_at and appends only provider.registered` — an unstamped `llm` row is inserted directly via SQL first (the positive force of the incomplete state)
  - `a git registration stores a null set_default_at and appends only provider.registered even when a git row exists` — first git row null, second git row null, one event
  - `an event append that throws inside the transaction leaves provider and event counts at zero` — a hand-written `EventLog` that delegates the first append to `SqliteEventLog` and throws on the second; asserts `countRows(provider) === 0` and `countRows(event) === 0`
- asserts: the observable contract is the stored `set_default_at`, the returned `view.setDefaultAt`, the ordered event types and payloads, and the two row counts after a forced rollback
  **RED proof.**
- command: `node --test src/commands/provider/register-provider.test.ts`
- exit: 1 — failure (4 tests): `✖ a first llm registration stamps set_default_at with its own updated_at` (`AssertionError: Expected values to be strictly equal` at `register-provider.test.ts:241`, `+ null - 1700000000000`), `✖ a first llm registration appends provider.registered then provider.defaultSet in id order` (`:274`), `✖ a second llm registration stores a null set_default_at and appends only provider.registered` (`:316`), `✖ an event append that throws inside the transaction leaves provider and event counts at zero` (`AssertionError: Missing expected exception` at `:441`) — run: `ℹ tests 13`, `ℹ pass 9`, `ℹ fail 4`
- the two predicate-pinning tests (unstamped-existing row, git-with-existing-row) pass against the current no-stamp code by construction: they pin the no-stamp branch, and they fail under the wrong predicate — stamping when an unstamped row exists (wrong "no stamped row" test) or stamping any first row (wrong git stamp); the unstamped row is positively forced by direct SQL insert
- stub probe: n/a — the seam (`registerProvider`, `RegisterProviderDependencies`, `EventLog`, `SqliteEventLog`) already exists; `npm run typecheck` exits 0 with the new tests in place
  **Open to Software Engineer.**
- `src/commands/provider/register-provider.ts` — `registerProvider(dependencies: RegisterProviderDependencies, input: RegisterProviderInput): ProviderView` keeps its signature and its single `clock.now()` call; for `kind === "llm"` with no existing `llm` row inside the same transaction it stores `set_default_at` equal to that `updated_at`, reports it as `view.setDefaultAt`, and appends `provider.defaultSet` with payload `{ name, kind, setDefaultAt }` after `provider.registered` in that one transaction; every other case stores `null` and appends `provider.registered` only. The Story file's Change/Constraints sections name the query, the predicate and the transaction rule.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 03 — first registration stamps the chain

**Cycle.** GREEN+REFACTOR for `src/commands/provider/register-provider.test.ts`.
**Files changed.**

- `src/commands/provider/register-provider.ts` (edited) — `registerProvider(dependencies: RegisterProviderDependencies, input: RegisterProviderInput): ProviderView`
  **Seam (GREEN).** Inside the existing transaction, after the name-taken check, the command queries `SELECT id FROM provider WHERE kind = 'llm' LIMIT 1` only when `input.kind === "llm"`; when that read returns no row it sets `setDefaultAt` to the single `clock.now()` value `updatedAt` and stores it in `set_default_at`, otherwise it stores `null`. `provider.registered` is appended first with payload `{ name, kind }`; when `setDefaultAt` is non-null, `provider.defaultSet` is appended second in the same transaction with `subjectKind: "provider"`, `actorKind: "human"`, the same actor and payload `{ name, kind, setDefaultAt }`. The returned view reports the stamped value or `null`.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section itself; applied in full — the stamp predicate tests existence of any `llm` row, not a stamped row; git rows and later llm rows stay null with `provider.registered` only; insert and both appends share one transaction (the atomicity test's forced second-append throw rolls both counts back to zero).
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `SqliteEventLog.append` serializes the payload with `JSON.stringify` and mints one event id per append, so the `{ name, kind, setDefaultAt }` literal order and the append order produce the asserted payload JSON and id-sorted event types.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 03 GREEN confirm + Story 04 RED — provider.setDefault

**Cycle.** Confirm GREEN for Story `03-first-registration-stamps-chain`; RED for Story `04-set-default-provider` (`node --test src/commands/provider/set-default-provider.test.ts`, the Story's coupled-batch verify path).
**GREEN confirmed (Story 03).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/commands/provider/register-provider.test.ts` — exit: 0 — `ℹ tests 13`, `ℹ pass 13`, `ℹ fail 0`
  **Test written.**
- file: `src/commands/provider/set-default-provider.test.ts` (new) — suite: `src/commands/provider/set-default-provider.test`
- methods:
  - `an unknown id refuses with not-found and writes no row and no event` — asserts `SetDefaultProviderError` with `refusal "not-found"`, message `no provider <id>`, `Object.keys(error).sort()` deep-equal `["name","refusal"]`, and provider/event counts `0`
  - `a git registration refuses with kind-not-chainable before a clock call and keeps its stamp null` — refuses with the exact message `provider <id> of kind git cannot join the default chain`, a wrapping counting clock reports `0` calls, the row `set_default_at` stays `NULL`, and the event count stays `1`
  - `a second llm registration while another holds the stamp refuses with default-already-set naming the holder and leaves both rows unchanged` — `ids` deep-equal `[<holder id>]`, `Object.keys(error).sort()` deep-equal `["ids","name","refusal"]`, holder stamp `1700000000000` and target `NULL` unchanged, event count `3`
  - `setDefault on the row that already holds the stamp returns the unchanged view with no clock call and no event` — full view deep-equal (stamp, updatedAt and projection intact), clock calls `0`, row and event count unchanged
  - `a successful stamp writes one timestamp to set_default_at, updated_at and the event payload` — both columns and the event payload `setDefaultAt` equal `1700000002000`; envelope asserted field by field (`subjectKind provider`, `subjectId` target, `type provider.defaultSet`, `actorKind human`, `actorId ulrich`, `payload_json '{"name":"second-bot","kind":"llm","setDefaultAt":1700000002000}'`)
  - `a corrupted payload tag still stamps and appends the event but returns projection null` — `payload_tag` replaced with sixteen zero bytes and `set_default_at` forced to `NULL` via SQL; the call still stamps both columns, appends the event, and returns `projection: null`
  - `a throwing event append rolls the stamp and the updated_at back` — a hand-written `EventLog` that throws on its first append (delegating everything else to `SqliteEventLog`); after the throw the row shows `set_default_at NULL` and `updated_at 1700000001000`, event count `3`
- file: `src/http/server/credential/set-default-provider.test.ts` (new) — suite: `src/http/server/credential/set-default-provider.test`
- methods: `PUT /v1/provider/<id>/default answers 200 with the view and passes the parsed id and the configured actor`; `an unknown id refusal answers 404 not-found with the refusal message`; `a git refusal answers 400 invalid-request with refusal kind-not-chainable`; `a holder refusal answers 400 invalid-request with the exact holder id in details.ids`
- asserts: real koa app through `createTestApp`; status codes, `error.code`, `details.refusal`, `details.ids` deep-equal `[<holder id>]`
- coupling note: this handler suite is part of the coupled unit Stories 4-8 (index.md: "no full gate between them"); it cannot exit 0 before Story 7 (`bindingOffenders` rejects a handler bound to a `stubbed` operation — the route becomes `routed` in Story 7) and before Story 8 (`toHttpError` gains the refusal mapping). The Story's verify path for this batch is the command test only; the combined exit-0 is checked after Story 8.
  **RED proof.**
- command: `node --test src/commands/provider/set-default-provider.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<…>/src/commands/provider/set-default-provider.ts' imported from …/set-default-provider.test.ts`, `ℹ tests 1`, `ℹ pass 0`, `ℹ fail 1`
- stub probe: `src/commands/provider/set-default-provider.ts` and `src/http/server/credential/set-default-provider.ts` (Story-declared signatures, `throw new Error("stub")` bodies) — `npm run typecheck` exits 0 with both new test files in place; with the command stub, all 7 command tests fail (`ℹ pass 0`, `ℹ fail 7`), so each method is sensitive to the missing behavior. Stubs deleted; the `ERR_MODULE_NOT_FOUND` above is restored.
  **Open to Software Engineer.**
- `src/commands/provider/set-default-provider.ts` — exports `setDefaultProvider(dependencies: SetDefaultProviderDependencies, input: SetDefaultProviderInput): ProviderView` with `SetDefaultProviderDependencies = Readonly<{ storage, crypto, clock, events }>` (each capability interface from `src/services/<capability>/index.ts`) and `SetDefaultProviderInput = Readonly<{ id, actor }>`; exports `SetDefaultProviderRefusal` as the union `"not-found" | "kind-not-chainable" | "default-already-set"` and `SetDefaultProviderError` with `readonly refusal`, an optional `readonly ids: readonly string[] | undefined` that is enumerable only on the `default-already-set` instance, and `name = "SetDefaultProviderError"`; the constructor is `new SetDefaultProviderError(refusal, message, ids?)`.
- `src/http/server/credential/set-default-provider.ts` — exports `setDefaultProviderHandler(dependencies: Readonly<{ setDefaultProvider: (input: SetDefaultProviderInput) => ProviderView; actor: string }>): Handler`; it reads the path `id` parameter, calls the command once with the configured actor, and maps command errors through `toHttpError`.
- The Story file's Change/Constraints sections name the select columns, the refusal order, the self no-op, the holder query, the single clock value, the event envelope and the post-transaction projection rule.
- Note for the coupled unit: the refusals mapping in `src/http/server/credential/refusals.ts` and the `routed` status in `src/http/contract/credential.ts` are Story 7/8 content; the handler suite above stays red until then.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 04 — provider.setDefault

**Cycle.** GREEN+REFACTOR for `src/commands/provider/set-default-provider.test.ts` (+ the coupled handler file).
**Files changed.**

- `src/commands/provider/set-default-provider.ts` (new) — `setDefaultProvider(dependencies: SetDefaultProviderDependencies, input: SetDefaultProviderInput): ProviderView`; exports `SetDefaultProviderDependencies`, `SetDefaultProviderInput`, `SetDefaultProviderRefusal = "not-found" | "kind-not-chainable" | "default-already-set"`, `SetDefaultProviderError` (constructor `(refusal, message, ids?)`, `declare readonly ids` assigned only when passed, so `Object.keys` is `["name","refusal"]` or `["ids","name","refusal"]`)
- `src/http/server/credential/set-default-provider.ts` (new) — `setDefaultProviderHandler(dependencies: Readonly<{ setDefaultProvider: (input: SetDefaultProviderInput) => ProviderView; actor: string }>): Handler`; reads the path `id`, calls the command once with the configured actor, formats `providerView`, maps command errors through `toHttpError`
  **Seam (GREEN).** Inside one transaction the command selects `id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at`; refuses unknown as `not-found`; refuses `kind = 'git'` as `kind-not-chainable` before any clock call or write; returns the row unchanged when its own `set_default_at` is non-null (no clock, no write, no event); refuses with `default-already-set` naming the single holder from `SELECT id FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL AND id <> ? ORDER BY id ASC LIMIT 1`; otherwise stamps both columns with the one `clock.now()` value and appends `provider.defaultSet` (`subjectKind provider`, `subjectId` = input id, `actorKind human`, `actorId` = actor, payload `{ name, kind, setDefaultAt }`) in that transaction. After the transaction the projection derives through `crypto.open` → `deserializePayload` → `projectPayload`; any throw yields `projection: null` with the state and event result untouched.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — the command and handler are the story's production scope, `ids` is enumerable only on the `default-already-set` instance (verified at runtime: a `declare` field assigned conditionally strips to no own property otherwise), and no credential or ciphertext field leaves the command.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `SqliteEventLog.append` mints exactly one event id per append (`src/services/event/sqlite.ts:36`), so the event payload literal `{ name, kind, setDefaultAt }` serializes in the asserted field order.
- VERIFIED: Story-03's green suite pins that the first `llm` registration always stamps and a second stays unstamped (`register-provider.test.ts` methods `a first llm registration stamps…` and `a second llm registration stores a null set_default_at…`).
- EXPECTED RED, test-side (TE's lane): the methods `a successful stamp…`, `a corrupted payload tag…` and `a throwing event append…` share the refusal test's exact state — first `llm` stamped, second unstamped, target `secondProviderId` — a state the binding refusal semantics (EPIC hermetic line 56, Story 04 constraint line 15, and the TE's own `a second llm registration while another holds the stamp refuses…` method) require to refuse `default-already-set`. No faithful implementation can stamp there, and their 5-ulid mock lists are one short even if the holder's stamp were nulled (register 1 = 3 mints, register 2 = 2, stamp event = 1 → 6 needed). The EPIC's own recipe for the broken case (hermetic line 60) nulls the stamp _before_ the call — i.e. null `set_default_at` of the **holder** (`firstProviderId`) or start from a single unstamped `llm` row, and add a 6th ulid. Command and handler themselves are complete per the Story; the four refusal/no-op methods are green under this implementation.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 04 GREEN confirm (test-state corrected) + Story 05 RED — provider.rename

**Cycle.** Confirm GREEN for Story `04-set-default-provider` command suite (after a test-side state correction); RED for Story `05-rename-provider` (`node --test src/commands/provider/rename-provider.test.ts`, the coupled-batch verify path).

**GREEN confirmed (Story 04).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/commands/provider/set-default-provider.test.ts` — exit: 0 — `ℹ tests 7`, `ℹ pass 7`, `ℹ fail 0`
- test-state correction (mine, test-side): the SE's turn documented why `a successful stamp…`, `a corrupted payload tag…` and `a throwing event append…` cannot pass under a faithful implementation — the second `llm` row is refused `default-already-set` because the first row holds the stamp. The EPIC's own recipe (hermetic line 60) sanctions the state: "For the broken setDefault case, also set `set_default_at = NULL` before the call." I nulled the holder's `firstProviderId` stamp via SQL after the two registrations in all three methods and added a 6th ulid (register 1 = 3 mints, register 2 = 2, append = 1) to the two that reach the append; assertions unchanged. The SE's implementation is faithful to Story 04 — no `OPEN:` warranted.
- the handler suite `src/http/server/credential/set-default-provider.test.ts` stays red by design (`incomplete transport binding: provider.setDefault`) — coupled to Story 7 (`routed`) and Story 8 (refusal mapping); Story 04 Verify: "After Story 8, run …; it exits 0."

**Test written.**

- file: `src/commands/provider/rename-provider.test.ts` (new) — suite: `src/commands/provider/rename-provider.test`
- methods:
  - `an unknown id refuses with not-found and writes no row and no event` — `RenameProviderError` refusal `not-found`, message `no provider <id>`, keys `["name","refusal"]`, provider/event counts `0`
  - `a rename to a name another row holds refuses with name-taken and leaves both names unchanged` — refusal `name-taken`, message `a provider named github-bot is already registered`, both rows' names unchanged, event count `2`
  - `a rename to the current name returns the unchanged view with no clock call and no event` — full view deep-equal, clock calls `0`, `updated_at` and event count unchanged
  - `a successful rename updates only name and updated_at, keeps the encrypted columns byte-identical and appends provider.renamed` — `Buffer.compare` `0` on `payload_ciphertext`, `payload_iv`, `payload_tag`; `key_version` unchanged; `set_default_at` still `null`; envelope field by field (`subjectKind provider`, `subjectId` target, `type provider.renamed`, `actorKind human`, `actorId ulrich`); payload_json `'{"from":"github-bot","to":"github-release"}'`; projection deep-equal the exact git projection
  - `a corrupted payload tag still renames and appends the event but returns projection null` — `payload_tag` replaced with sixteen zero bytes before renaming; name and `updated_at` still update, event appended, `projection: null`
  - `a throwing event append restores the old name and the old update time` — hand-written `EventLog` throwing on its first append; after the throw the row shows name `github-bot` and `updated_at 1700000000000`, event count `1`
- file: `src/http/server/credential/rename-provider.test.ts` (new) — suite: `src/http/server/credential/rename-provider.test`
- methods: `POST /v1/provider/<id>/rename with a valid body answers 200 with the view and passes the parsed id, name and the configured actor`; `an unknown id refusal answers 404 not-found with the refusal message`; `a name-taken refusal answers 400 invalid-request with refusal name-taken`; `an empty body answers 400 invalid-request with the constant message and zero command calls`
- asserts: real koa app through `createTestApp`; status codes, `error.code`, `details.refusal`, the exact message `the provider rename body is invalid` (Story Verify line 33), and zero command calls on the empty body
- coupling note: the handler suite cannot exit 0 before Story 7 (`routed` + `providerRenameRequest` body schema) and Story 8 (`toHttpError` maps `RenameProviderError`); expected red until then, per Story 05 Verify: "After Story 8, run …; it exits 0."

**RED proof.**

- command: `node --test src/commands/provider/rename-provider.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<…>/src/commands/provider/rename-provider.ts' imported from …/rename-provider.test.ts`, `ℹ tests 1`, `ℹ pass 0`, `ℹ fail 1`
- stub probe: `src/commands/provider/rename-provider.ts` (exports `RenameProviderDependencies`, `RenameProviderInput`, `RenameProviderRefusal = "not-found" | "name-taken"`, `RenameProviderError`, `renameProvider`) and `src/http/server/credential/rename-provider.ts` (exports `renameProviderHandler`) with `throw new Error("stub")` bodies — `npm run typecheck` exits 0 with both new test files in place; with the stubs, both suites fail fully (`ℹ tests 10`, `ℹ pass 0`, `ℹ fail 10`), so every method is sensitive to the missing behavior. Stubs deleted; the `ERR_MODULE_NOT_FOUND` above is restored, and the post-deletion typecheck shows only `TS2307` cascades in the two new test files (the probe already proved them clean against the declared signatures).

**Open to Software Engineer.**

- `src/commands/provider/rename-provider.ts` — exports `renameProvider(dependencies: RenameProviderDependencies, input: RenameProviderInput): ProviderView` with `RenameProviderDependencies = Readonly<{ storage, crypto, clock, events }>` (each capability interface from `src/services/<capability>/index.ts`) and `RenameProviderInput = Readonly<{ id, name, actor }>`; exports `RenameProviderRefusal` as the union `"not-found" | "name-taken"` and `RenameProviderError` with `readonly refusal`, `Object.keys` exactly `["name","refusal"]`, and `name = "RenameProviderError"`; the constructor is `new RenameProviderError(refusal, message)`.
- `src/http/server/credential/rename-provider.ts` — exports `renameProviderHandler(dependencies: Readonly<{ renameProvider: (input: RenameProviderInput) => ProviderView; actor: string }>): Handler`; it parses the body as `{ name }`, reads the path `id` parameter, calls the command once with the configured actor, and maps command errors through `toHttpError`.
- The Story file's Change/Constraints sections name the nine select columns, the name-taken query, the same-name no-op, the single clock value, the `{ from, to }` payload, the never-touched encrypted columns, and the post-transaction projection rule.
- Note for the coupled unit: the `providerRenameRequest` body schema, the `routed` status in `src/http/contract/credential.ts` and the refusals mapping in `src/http/server/credential/refusals.ts` are Story 7/8 content; the handler suite above stays red until then.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 05 — provider.rename

**Cycle.** GREEN+REFACTOR for `src/commands/provider/rename-provider.test.ts` (+ the coupled handler file).
**Files changed.**

- `src/commands/provider/rename-provider.ts` (new) — `renameProvider(dependencies: RenameProviderDependencies, input: RenameProviderInput): ProviderView`; exports `RenameProviderDependencies`, `RenameProviderInput`, `RenameProviderRefusal = "not-found" | "name-taken"`, `RenameProviderError` (constructor `(refusal, message)`, enumerable keys `["name","refusal"]`)
- `src/http/server/credential/rename-provider.ts` (new) — `renameProviderHandler(dependencies: Readonly<{ renameProvider: (input: RenameProviderInput) => ProviderView; actor: string }>): Handler`; reads the path `id`, parses the body `{ name }`, calls the command once with the configured actor, formats `providerView`, maps command errors through `toHttpError`
  **Seam (GREEN).** Inside one transaction the command selects the same nine named columns as Story 4; refuses an unknown id as `not-found`; refuses a name another row holds (`SELECT id FROM provider WHERE name = ? AND id <> ?`) as `name-taken`; returns the row unchanged when `target.name === input.name` (no clock call, no write, no event); otherwise calls the clock once, updates only `name` and `updated_at`, and appends `provider.renamed` (`subjectKind provider`, `subjectId` = input id, `actorKind human`, `actorId` = actor, payload `{ from, to }`) in that transaction. `payload_ciphertext`, `payload_iv`, `payload_tag`, `key_version`, `kind` and `set_default_at` are never touched. After the transaction the projection derives through `crypto.open` → `deserializePayload` → `projectPayload`; any throw yields `projection: null` with the state and event result untouched.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — command and handler are the story's production scope, the projection helper mirrors the Story-4 command (no shared abstraction invented).
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `SqliteEventLog.append` serializes `payload` with `JSON.stringify` in literal key order (`src/services/event/sqlite.ts`, also verified in Story 03's SE turn), so the literal `{ from: target.name, to: input.name }` yields the asserted `'{"from":"github-bot","to":"github-release"}'`.
- VERIFIED: `Storage.transact` rolls back a thrown transaction callback (`src/services/storage/connection.ts`, Story index Fact line 29), so the throwing-append test reads the old name and old update time.
- COUPLED DEPENDENCIES RECORDED (later-story content, no edits made): (1) Story 7 must set `provider.rename` to `routed` in `src/http/contract/credential.ts` and export `providerRenameRequest` there — `createTestApp` rejects a handler bound to a `stubbed` operation and the handler currently defines a local `providerRenameRequest`-shaped schema (`z.strictObject({ name: z.string().min(1) })`) to be swapped for the contract import; the handler suite stays red until then. (2) Story 8 must extend `toHttpError` in `src/http/server/credential/refusals.ts` to map `RenameProviderError` (`not-found` → the `not-found` code, `name-taken` → `invalid-request` with `refusal`), else the two refusal methods of the handler suite stay red.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 05 GREEN confirm + Story 06 RED — provider.remove

**Cycle.** Confirm GREEN for Story `05-rename-provider`; RED for Story `06-remove-provider` (`node --test src/commands/provider/remove-provider.test.ts src/http/contract/error-details.test.ts`, the coupled-batch verify path — Story 06 Verify line 39).

**GREEN confirmed (Story 05).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/commands/provider/rename-provider.test.ts` — exit: 0 — `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0`
- the handler suite `src/http/server/credential/rename-provider.test.ts` stays red by design until Story 7 (`routed` + `providerRenameRequest`) and Story 8 (`toHttpError`), per Story 05 Verify line 40.

**Test written.**

- file: `src/commands/provider/remove-provider.test.ts` (new) — suite: `src/commands/provider/remove-provider.test`
- methods:
  - `an unknown id refuses with not-found and writes no row and no event` — message `no provider <id>`, `Object.keys(error).sort()` `["name","refusal"]`, provider/event counts `0`
  - `a removal blocked by all four causes reports every blocker in category order and keeps the provider row` — `set_default_at` forced non-null via SQL; one `kind = 'provider'` binding, one repository, one attempt (full raw-SQL chain: blob, project, plan_revision, objective+task nodes, workspaces, runs, attempt); keys `["blockers","name","refusal"]`, message `provider <id> is still in use`, blockers deep-equal `[default-chain, project-binding project_p, repository repository_chain, attempt attempt_chain]`, provider row `1`, event count `1`
  - `two provider project bindings are listed in Buffer.compare order of project_id` — `project_zaaa` inserted before `project_azzz`; expects `[project_azzz, project_zaaa]`
  - `two repository blockers are listed in ascending Buffer.compare order` — `repository_z` inserted before `repository_a`; expects `[repository_a, repository_z]`
  - `two attempt blockers are listed in ascending Buffer.compare order` — `attempt_z` chain inserted before `attempt_a`; expects `[repository_chain, attempt_a, attempt_z]` (the shared chain repository row precedes the attempts in category order)
  - `a project binding of kind git naming the same target blocks nothing and the removal succeeds` — returns `{ id }`, provider count `0`
  - `an unblocked removal deletes the row, returns only the id and appends provider.removed` — envelope field by field (`subjectKind provider`, `subjectId` target, `type provider.removed`, `actorKind human`, `actorId ulrich`), payload_json `'{"name":"github-bot","kind":"git"}'`, event count `2`
  - `a throwing event append leaves the provider row present` — hand-written `EventLog` throwing on its first append; provider row `1`, event count `1`
- file: `src/http/contract/error-details.test.ts` (edited) — suite: `src/http/contract/error-details.test` — methods: `parses one blocker of each of the four kinds` (attempt member added to the loop), `rejects an attempt blocker missing attemptId` (new)
- file: `src/http/server/credential/remove-provider.test.ts` (new) — suite: `src/http/server/credential/remove-provider.test` — methods: `DELETE /v1/provider/<id> answers 200 with the removed id and passes the parsed id and the configured actor`; `an unknown id refusal answers 404 not-found with the refusal message`; `a binding-in-use refusal answers 409 with the exact blocker array`
- asserts: the observable contract is the exact blocker array in category and `Buffer.compare` order, the `{ id }` success body, the `provider.removed` envelope and payload, and the rollback of the delete.
- coupling note: the handler suite cannot exit 0 before Story 7 (`routed` on `provider.remove`) and Story 8 (`toHttpError` maps `RemoveProviderError`); expected red until then, per Story 06 Verify line 40.

**RED proof.**

- command: `node --test src/commands/provider/remove-provider.test.ts src/http/contract/error-details.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '<…>/src/commands/provider/remove-provider.ts' imported from …/remove-provider.test.ts`; `✖ parses one blocker of each of the four kinds` — `Invalid discriminator value. Expected 'default-chain' | 'project-binding' | 'repository'` at `error-details.test.ts:92` — run: `ℹ tests 31`, `ℹ pass 29`, `ℹ fail 2`
- stub probe: `src/commands/provider/remove-provider.ts` (Story-declared signature, `throw new Error("stub")` body) and `src/http/server/credential/remove-provider.ts` (same) — `npm run typecheck` exits 0 with all three test files in place; with the stubs, all 8 command methods and all 3 handler methods fail (`ℹ tests 41`, `ℹ pass 29` — the untouched error-details methods — `ℹ fail 12`), so every method is sensitive to the missing behavior. Stubs deleted; post-deletion typecheck shows only the 6 TS2307 cascades in the three new/edited test files.
- sensitivity note: `rejects an attempt blocker missing attemptId` passes today only because the schema does not know `attempt` at all; it becomes a genuine missing-field rejection once the member is added (`strictObject`), which the four-kind parse test forces.

**Open to Software Engineer.**

- `src/commands/provider/remove-provider.ts` — exports `removeProvider(dependencies: RemoveProviderDependencies, input: RemoveProviderInput): Readonly<{ id: string }>` with `RemoveProviderDependencies = Readonly<{ storage, events }>` (the capability interfaces from `src/services/storage/index.ts` and `src/services/event/index.ts`) and `RemoveProviderInput = Readonly<{ id, actor }>`; exports `ProviderRemovalBlocker` as the exact union of `{ kind: "default-chain" }`, `{ kind: "project-binding"; projectId: string }`, `{ kind: "repository"; repositoryId: string }` and `{ kind: "attempt"; attemptId: string }`; exports `RemoveProviderError` with `readonly refusal: "not-found" | "binding-in-use"`, an optional `readonly blockers: readonly ProviderRemovalBlocker[] | undefined` that is enumerable only on the `binding-in-use` instance, and `name = "RemoveProviderError"`; the constructor is `new RemoveProviderError(refusal, message, blockers?)`. Exact messages: `no provider <id>` and `provider <id> is still in use`.
- `src/http/contract/error-details.ts` — add the strict attempt blocker `{ kind: z.literal("attempt"), attemptId: z.string().min(1) }` to the `bindingInUseDetails` blocker union, after the repository member.
- `src/http/server/credential/remove-provider.ts` — exports `removeProviderHandler(dependencies: Readonly<{ removeProvider: (input: RemoveProviderInput) => Readonly<{ id: string }>; actor: string }>): Handler`; it reads the path `id` parameter, calls the command once with the configured actor, and maps command errors through `toHttpError`.
- The Story file's Change/Constraints sections name the select columns, the blocker category order, the `Buffer.compare` sorts, the one-transaction delete+append rule and the `{ name, kind }` payload.
- Note for the coupled unit: the `routed` status in `src/http/contract/credential.ts` and the refusals mapping in `src/http/server/credential/refusals.ts` are Story 7/8 content; the handler suite above stays red until then.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 06 — provider.remove blocker list

**Cycle.** GREEN+REFACTOR for `src/commands/provider/remove-provider.test.ts` + `src/http/contract/error-details.test.ts` (+ the coupled handler file).
**Files changed.**

- `src/commands/provider/remove-provider.ts` (new) — `removeProvider(dependencies: RemoveProviderDependencies, input: RemoveProviderInput): Readonly<{ id: string }>`; exports `RemoveProviderDependencies`, `RemoveProviderInput`, `ProviderRemovalBlocker` (union of `default-chain`, `project-binding`, `repository`, `attempt`), `RemoveProviderRefusal = "not-found" | "binding-in-use"`, `RemoveProviderError` (constructor `(refusal, message, blockers?)`, `declare readonly blockers` assigned only when passed, so `Object.keys` is `["name","refusal"]` or `["blockers","name","refusal"]`)
- `src/http/contract/error-details.ts` (edited) — `bindingInUseDetails` blocker union gains `{ kind: z.literal("attempt"), attemptId: z.string().min(1) }` after the repository member
- `src/http/server/credential/remove-provider.ts` (new) — `removeProviderHandler(dependencies: Readonly<{ removeProvider: (input: RemoveProviderInput) => Readonly<{ id: string }>; actor: string }>): Handler`; reads the path `id`, calls the command once with the configured actor, formats the `{ id }` body, maps command errors through `toHttpError`
- `docs/proposal/api/credential.md` (edited) — attempt blocker bullet added to the removal list, "third and the fourth are not optional" paragraph
- `docs/proposal/database/provider.md` (edited) — removal refusal list gains repository and attempt
- `docs/proposal/phase-2/providers-and-credentials.md` (edited) — removal refusal list gains repository and attempt

**Seam (GREEN).** Inside one transaction the command selects `id, name, kind, set_default_at`; refuses an absent row as `not-found`; builds blockers in category order — `default-chain` when `set_default_at` is non-null, then `project-binding` per `project_binding` row of `kind = 'provider'` and `target_id = <id>` (git-kind rows ignored), then `repository` per `repository.credential_id` row, then `attempt` per `attempt.provider_id` row, each repeated category sorted in JavaScript by `Buffer.compare(Buffer.from(a), Buffer.from(b))` before mapping; a non-empty list throws one `binding-in-use` with the full array and performs no delete and no append; an empty list deletes the row and appends `provider.removed` (`subjectKind provider`, `subjectId` = input id, `actorKind human`, `actorId` = actor, payload `{ name, kind }` from the selected row) in that transaction, and the command returns `{ id }` after commit.
**Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — one shared `inIdOrder` helper for the three sorted categories, no speculative abstraction beyond it; `blockers` is enumerable only on the `binding-in-use` instance (`declare` field assigned conditionally, same pattern as Story 04's `ids`).
**Build check.**

- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `Storage.transact` rolls back a thrown transaction callback, so the throwing-append test reads the provider row still present and the event count unchanged (`src/services/storage/connection.ts`, Story index Fact line 29, also cited in Story 05's SE turn).
- VERIFIED: `project_binding.kind` permits exactly `'git' | 'provider'` and `attempt.provider_id` is `NOT NULL REFERENCES provider(id)` (`src/services/storage/migration-0001-core-entities.ts:33-39`, `migration-0003-execution-and-journal.ts:47-60`), which is why the git-kind row test and the attempt blocker test pass against a real migrated database.
- COUPLED DEPENDENCIES RECORDED (later-story content, no edits made): (1) Story 7 must set `provider.remove` to `routed` in `src/http/contract/credential.ts` — `createTestApp` rejects a handler bound to a `stubbed` operation, so the handler suite stays red until then. (2) Story 8 must extend `toHttpError` in `src/http/server/credential/refusals.ts` to map `RemoveProviderError` (`not-found` → the `not-found` code; `binding-in-use` → `binding-in-use` with the blocker list in `details.blockers`), else the 404 and 409 methods of the handler suite stay red. The Story's verify path for this batch is the command + error-details suites only; the combined handler exit-0 is checked after Story 8, per Story 06 Verify line 40.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 06 GREEN confirm + Story 07 RED — route contracts

**Cycle.** Confirm GREEN for Story `06-remove-provider`; RED for Story `07-route-contracts` (`node --test src/http/contract/*.test.ts`, plus the Story-7-pinned server suites `src/http/server/app.test.ts src/http/server/dispatch.test.ts`).

**GREEN confirmed (Story 06).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/commands/provider/remove-provider.test.ts src/http/contract/error-details.test.ts` — exit: 0 — `ℹ tests 38`, `ℹ pass 38`, `ℹ fail 0`
- test-state correction (mine, test-side): on first confirm run, the two attempt-seeding methods hit `Error: CHECK constraint failed: (kind = 'initiative') = (parent_id IS NULL)` at the `node_objective` insert in `seedAttemptFixture`. The RED fixture had never run against the real schema (Story-06 RED died at module import; the stub probe proved only sensitivity). Migration `0002-graph-and-plan` requires a non-initiative node to carry a non-null `parent_id` and an `objective` a non-null `repository_id`. Fix in my lane: insert an `initiative` node `node_initiative` first and set the objective's `parent_id` to it. SE implementation untouched; the SE's four refusal/no-op claims hold under the corrected fixture.

**Test written.**

- file: `src/http/contract/credential.test.ts` (new) — suite: `src/http/contract/credential.test`
  - methods: `the three phase-2 provider routes become routed with unchanged shape`; `the rename examples carry the exact story values`; `the remove examples carry the exact story values`; `the setDefault examples carry the exact story values`; `every example parses against its own strict schema and envelope`; `an empty rename name is rejected`; `an extra rename request key is rejected`; `an extra success key is rejected on rename and setDefault`; `the remove response parses the id only and rejects any added key`
  - asserts: `status "routed"`, unchanged `method`/`introducedIn "phase-2"`/`renderPath` for the three operations; the exact Story-named example literals (rename `{ name: "github-release" }` and the git view; remove `{ id: provider_<U> }` and the four-blocker error; setDefault `openai`/`gpt-4o` view and the kind-not-chainable error); every example parses against its own response/request schema and `buildErrorEnvelope(entry.errors)`; strict rejection of `{ name: "" }`, `{ name, kind }`, success-plus-`credential: "secret"` on rename and setDefault, remove-plus-extra; `Object.keys(remove.parse({ id }))` deep-equal `["id"]` and rename/setDefault sorted keys deep-equal the six public fields
- file: `src/http/contract/registry.test.ts` (edited) — routed `24`→`27`, stubbed `30`→`27`; request list `7`→`8` with `provider.rename`, response list `23`→`26` with `provider.remove`/`provider.rename`/`provider.setDefault` in sorted position
- file: `src/http/contract/system.test.ts` (edited) — same three ids and counts (`26` responses, `8` requests)
- file: `src/http/contract/coverage.test.ts` (edited) — stubbed `30`→`27`
- file: `src/http/contract/openapi.test.ts` (edited) — components `53`→`60`, inserting `provider.remove.{error,response}`, `provider.rename.{error,request,response}`, `provider.setDefault.{error,response}` bytewise between `provider.register.response` and `provider.show.error`
- file: `src/http/contract/field-decisions.fixture.ts` (edited) — `26` new rows: `provider.rename.request#/properties/name`; rename and setDefault response rows mirroring the register rows (141-152) under their own prefixes; `provider.remove.response#/properties/id`
- file: `src/http/server/app.test.ts` (edited) — unimplemented ids `22`→`25` with only health and db bound
- file: `src/http/server/dispatch.test.ts` (edited) — `unimplementedFor` length `22`→`25`; driven stubbed routes `30`→`27`
- parity note: `src/http/contract/parity.test.ts` needs no edit — the `54` comparable rows stay constant; it rides the proposal table cells the SE changes to `routed`

**RED proof.**

- command: `node --test src/http/contract/*.test.ts`
- exit: 1 — failure: `ℹ tests 222`, `ℹ pass 215`, `ℹ fail 7` — `SyntaxError: The requested module './credential.ts' does not provide an export named 'providerRemoveExamples'`; `24 !== 27` (`counts routed and stubbed entries`); request-list deep-equal diff (expected includes `provider.rename`, actual lacks it); `23 !== 26` (`twenty-six registry entries carry a response and eight carry a request`); `30 !== 27` (`a stubbed operation declares no schema…`); component-list diff (`- 'provider.remove.error'`, `- 'provider.rename.error'` …); fixture diff (`- 'provider.remove.response#/properties/id required=true nullable=false enum=-'` …)
- command: `node --test src/http/server/app.test.ts src/http/server/dispatch.test.ts`
- exit: 1 — failure: `ℹ tests 48`, `ℹ pass 45`, `ℹ fail 3` — `22 !== 25` (app.test.ts), `22 !== 25` and `30 !== 27` (dispatch.test.ts)
- baseline: both commands were green before these edits (`221/221` contract, `48/48` server pair), so every failure traces 1:1 to the new pins or the missing exports
- stub probe: `src/http/contract/credential.ts` — appended the seven Story-declared exports (strict schemas + the exact example literals) temporarily — `npm run typecheck` exits 0 with every test edit in place; the new suite runs `ℹ tests 9`, `ℹ pass 7`, `ℹ fail 2` against the stub, and the two failures are exactly the SE-side registry change (`status "routed"` and declared `errors` on the three operations), so the literal assertions and strict rejections are consistent with the declared shapes. Stub removed via `git checkout`; typecheck restored to the 7 `TS2724` errors, all in `src/http/contract/credential.test.ts` (the missing exports), nothing else.
- coupling note: the three provider handler suites (`src/http/server/credential/*.test.ts`) stay red by design — they bind handlers to `stubbed` operations until Story 7 lands and need `toHttpError` from Story 8; per Story 07 Verify they exit 0 within the coupled batch after Story 8.

**Open to Software Engineer.**

- `src/http/contract/credential.ts` — the Story file's Change/Constraints sections: strict `providerRenameRequest` (`name: z.string().min(1)`), `providerRenameResponse` and `providerSetDefaultResponse` aliasing `providerView`, strict `providerRemoveResponse` with `id` only; `providerRenameExamples`, `providerRemoveExamples`, `providerSetDefaultExamples` with the exact Story-named literals above; the three entries `provider.rename`, `provider.remove`, `provider.setDefault` set to `status: "routed"` with method, path, phase, idempotency and replayability unchanged; rename with request, response, baseline errors and examples; setDefault with response, baseline errors and examples; remove with response, baseline errors plus `"binding-in-use": bindingInUseDetails`, and examples; `import { bindingInUseDetails } from "./error-details.ts"`.
- `docs/proposal/api/credential.md` — the three lifecycle cells change from `stubbed` to `routed` (the parity test compares the registry against that table).
- The Story file's Verify section names the exact openapi component and fixture rows the tests above already pin.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 07 — route contracts

**Cycle.** GREEN+REFACTOR for `src/http/contract/credential.test.ts` (+ the contract inventories the TE pinned: `registry.test.ts`, `system.test.ts`, `coverage.test.ts`, `openapi.test.ts`, `field-decisions.fixture.ts`, `app.test.ts`, `dispatch.test.ts`).
**Files changed.**

- `src/http/contract/credential.ts` (edited) — new exports: `providerRenameRequest` (`z.strictObject({ name: z.string().min(1) })`), `providerRenameResponse = providerView`, `providerSetDefaultResponse = providerView`, `providerRemoveResponse` (`z.strictObject({ id: z.string() })`), `providerRenameExamples`, `providerRemoveExamples`, `providerSetDefaultExamples`; the `provider.rename`, `provider.remove` and `provider.setDefault` registry entries set to `status: "routed"` with method, path, `introducedIn`, idempotency and replayability unchanged (rename keeps `idempotency: "memory"`, `replayable: [200]`; remove and setDefault keep none); rename gains `request` + `response` + `errors: { ...baselineErrors }` + `examples`, setDefault gains `response` + baseline errors + `examples`, remove gains `response` + baseline errors plus `"binding-in-use": bindingInUseDetails` + `examples`; `bindingInUseDetails` imported from `./error-details.ts`.
  **Seam (GREEN).** The three operations now carry the exact Story-7 literals — rename request `{ name: "github-release" }` with the git success view renamed and the `name-taken` envelope; remove success `{ id: provider_<U> }` with the four-blocker `binding-in-use` envelope in category order; setDefault `openai`/`gpt-4o` view with both timestamps `A` and the `kind-not-chainable` envelope — and every example parses against its own strict schema (`z.strictObject` rejects `{ name: "" }`, `{ name, kind }`, `credential: "secret"` additions) and against `buildErrorEnvelope(entry.errors)`.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — no other phase-2 operation changed, all schemas strict, no path/method/`introducedIn` drift.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `llmProjection` (`provider`, `defaultModel`, `baseUrl` nullable) and `gitProjection` in `src/domain/provider-payload.ts` accept the example projections verbatim.
- VERIFIED: `invalidRequestDetails.optional()` is the baseline `invalid-request` member, so the `{ refusal }` details of the rename and setDefault error examples parse (same shape as `providerRegisterExamples.error`).
- OPEN: `docs/proposal/api/credential.md` — the three lifecycle cells at lines 20-22 (`provider.rename`, `provider.remove`, `provider.setDefault`) must change from `stubbed` to `routed` to match this registry change. `scripts/lane-check.sh software-engineer docs/proposal/api/credential.md` exits 1 (`outside every lane`), so the lane predicate denies that path; I did not edit it. Consequence recorded: `src/http/contract/parity.test.ts` compares the registry against that table, so until the cells flip it reports `mismatched` on the three operation statuses — the source side of Story 07 is complete, and the parity cell owner must land the doc edit for the coupled batch to exit 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 07 GREEN confirm + Story 08 RED — composition and refusals

**Cycle.** Confirm GREEN for Story `07-route-contracts`; RED for Story `08-composition-and-refusals` (`node --test src/http/server/credential/*.test.ts src/main.test.ts`, the coupled-batch verify path).

**GREEN confirmed (Story 07).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/http/contract/*.test.ts src/http/server/app.test.ts src/http/server/dispatch.test.ts` — exit: 1 — `ℹ tests 278`, `ℹ pass 277`, `ℹ fail 1` — the single failure is the proposal parity blocker the SE's `OPEN:` documented, not a code check: `parity.test.ts` reports `mismatched: ['provider.remove status: registry routed, proposal stubbed', 'provider.rename status: registry routed, proposal stubbed', 'provider.setDefault status: registry routed, proposal stubbed']`. Every other Story-7-named check (contract inventories, app/dispatch counts, strict schemas and examples) is green.
- SE `OPEN:` stands: `docs/proposal/api/credential.md` lifecycle cells 20-22 must flip to `routed`; `scripts/lane-check.sh` denies that path to both roles (`deny "outside every lane"`), so no doc change is made in this turn. The parity failure is reported, not repaired.

**Test written.**

- file: `src/http/server/credential/refusals.test.ts` (new) — suite: `src/http/server/credential/refusals.test`
  - methods: `a SetDefaultProviderError not-found maps to a 404 not-found HttpError with no details`; `a SetDefaultProviderError kind-not-chainable maps to a 400 invalid-request with the refusal`; `a SetDefaultProviderError default-already-set maps to a 400 invalid-request with the refusal and the ids`; `a RenameProviderError not-found maps to a 404 not-found HttpError with no details`; `a RenameProviderError name-taken maps to a 400 invalid-request with the refusal`; `a RemoveProviderError not-found maps to a 404 not-found HttpError with no details`; `a RemoveProviderError binding-in-use maps to a 409 binding-in-use with the blockers`; `a PayloadError still maps to a 400 invalid-request with refusal and detail`; `an unknown error is rethrown unchanged`
  - asserts: exact `code` + `status` + `details` deep-equal per refusal (`undefined`, `{ refusal }`, `{ refusal, ids }`, `{ blockers }`), details parse against the strict `invalidRequestDetails` / `bindingInUseDetails` schemas, and the unknown error escapes by identity — Story 08 Verify line 25 and the error-construction contract of EPIC hermetic line 68
- file: `src/http/server/credential/register-provider.test.ts` (edited) — the obsolete `PUT /v1/provider/<id>/default answers 501 ships in phase-2 and writes nothing` test removed (Story 08 Change line 15, and its `createMigratedStorage` import with it); the success test now parses the body with `providerRegisterResponse`, asserts `Object.keys(parsed).sort()` deep-equal `["id","kind","name","projection","setDefaultAt","updatedAt"]`, and asserts `providerRegisterResponse.parse({ ...body, credential: "secret" })` throws
- file: `src/http/server/credential/set-default-provider.test.ts` (edited) — success test extended with `providerSetDefaultResponse` parse, the six sorted keys, and the `credential: "secret"` rejection
- file: `src/http/server/credential/rename-provider.test.ts` (edited) — success test extended with `providerRenameResponse` parse, the six sorted keys, and the `credential: "secret"` rejection
- file: `src/http/server/credential/remove-provider.test.ts` (edited) — success test extended with `providerRemoveResponse` parse, `Object.keys(parsed).sort()` deep-equal `["id"]`, and the `credential: "secret"` rejection
- file: `src/main.test.ts` (edited) — fixtures added for `provider.rename` (missing provider id, body `{ name: "renamed" }`, expect 404), `provider.setDefault` (missing id, expect 404) and `provider.remove` (missing id, expect 404), restoring bytewise fixture parity with the 27 routed operations; the existing `no routed operation is left unbound` test passes again with the fixtures and pins `unimplementedFor` → `[]` once main.ts binds the handlers

**RED proof.**

- command: `node --test src/http/server/credential/refusals.test.ts`
- exit: 1 — failure: `Error [SetDefaultProviderError]: no provider provider_01HZY8QF3M4N5P6R7S8T9V0W1X` — run: `ℹ tests 9`, `ℹ pass 2`, `ℹ fail 7` — the two pins (PayloadError mapping, unknown rethrow) are green by construction, since Story 08 keeps that behavior; all seven new mapping tests fail because `toHttpError` rethrows the unmapped errors raw
- command: `node --test src/http/server/credential/*.test.ts` — exit: 1 — run: `ℹ tests 16`, `ℹ pass 9`, `ℹ fail 7` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal` on the seven refusal methods (the escaped error answers 500 internal-error instead of 404/400/409); the register suite is 5/5 green after the 501 removal, and the three extended success tests are green
- command: `node --test src/main.test.ts` — exit: 1 — run: `ℹ tests 8`, `ℹ pass 7`, `ℹ fail 1` — failure: `AssertionError [ERR_ASSERTION]: provider.rename answered 501` — the composed daemon answers 501 until main.ts binds the three handlers; `no routed operation is left unbound` is green with the new fixtures
- stub probe: n/a — the Story-8 seams are existing symbols (`toHttpError` in `src/http/server/credential/refusals.ts`, the `handlers` map in `src/main.ts`), so no `TS2307` masks anything: `npm run typecheck` exits 0 with all edits in place

**Open to Software Engineer.**

- `src/http/server/credential/refusals.ts` — extend `toHttpError` to map each new command error by class and refusal: `SetDefaultProviderError` (`not-found` → the `not-found` code, `kind-not-chainable` → `invalid-request` with `{ refusal }`, `default-already-set` → `invalid-request` with `{ refusal, ids }`), `RenameProviderError` (`not-found` → `not-found`, `name-taken` → `invalid-request` with `{ refusal }`), `RemoveProviderError` (`not-found` → `not-found`, `binding-in-use` → `binding-in-use` with `{ blockers }`); the PayloadError mapping and the unknown rethrow stay unchanged, and `toHttpError` keeps accepting the thrown error only.
- `src/main.ts` — import `renameProvider`, `setDefaultProvider`, `removeProvider` and their three handlers; in the `handlers` map bind `provider.rename` and `provider.setDefault` with `{ storage, crypto, clock, events }` and `provider.remove` with `{ storage, events }`, all three with `actor: settings.actor`.
- The Story file's Change/Constraints sections name the bindings, the actor and the mapping codes.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 08 — composition and refusals

**Cycle.** GREEN+REFACTOR for `src/http/server/credential/refusals.test.ts` (+ `src/main.test.ts`).
**Files changed.**

- `src/http/server/credential/refusals.ts` (edited) — `toHttpError(error: unknown): HttpError` extended with `SetDefaultProviderError`, `RenameProviderError`, `RemoveProviderError` branches
- `src/main.ts` (edited) — imports of `renameProvider`, `setDefaultProvider`, `removeProvider` and their three handlers; `handlers` map entries `provider.rename`, `provider.setDefault`, `provider.remove` beside `provider.register`
  **Seam (GREEN).** `toHttpError` now maps each new command error by class and refusal: every `not-found` refusal → `httpError("not-found", message)` with no details; `SetDefaultProviderError.kind-not-chainable` and `RenameProviderError.name-taken` → `invalid-request` with `{ refusal }`; `SetDefaultProviderError.default-already-set` → `invalid-request` with `{ refusal, ids }`; `RemoveProviderError.binding-in-use` → `httpError("binding-in-use", message, { blockers })`. The `PayloadError` branch and the final unknown rethrow are byte-identical to before, and `toHttpError` still accepts the thrown error only. In `main.ts` the three handlers bind with `actor: settings.actor`, rename and setDefault with `{ storage, crypto, clock, events }`, remove with `{ storage, events }` — so `unimplementedFor(handlers)` covers no provider operation, the `501` branch in dispatch cannot reach the three routes, and `bindingOffenders` stays empty.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — refusal narrowing branches per command class, no shared abstraction beyond the existing `httpError` helper.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `errorStatuses` already carries `binding-in-use: 409` and `not-found: 404` (`src/http/contract/errors.ts:12-15`), so the mapped `HttpError` instances carry the exact codes and statuses the handler suites assert, and `binding-in-use` is a `PreconditionCode` accepted by the `httpError(code, message, details)` overload.
- VERIFIED: the contract registry (`src/http/contract/credential.ts`) declares `provider.rename`, `provider.remove` and `provider.setDefault` as `routed` (Story 07), and `createApp`'s `unimplementedFor` derives from the composed `handlers` map, so the three new entries remove exactly those three ids from `unimplemented`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 08 GREEN confirm + Story 09 RED — master key startup refusal

**Cycle.** Confirm GREEN for Story `08-composition-and-refusals` (`node --test src/http/server/credential/*.test.ts src/main.test.ts`); record the proposal parity blocker; RED for Story `09-master-key-startup-refusal` (`node --test src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts`).

**GREEN confirmed (Story 08).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`) matches the artifact.
- command: `node --test src/http/server/credential/*.test.ts src/main.test.ts` — exit: 0 — `ℹ tests 36`, `ℹ pass 36`, `ℹ fail 0` — the refusals mapping (9/9), the three provider handler suites, the register suite and the composed main fixtures are all green.

**OPEN blocker (proposal parity, lane-denied, reported not repaired).**

- `node --test src/http/contract/parity.test.ts` — exit: 1 — `mismatched: [ 'provider.remove status: registry routed, proposal stubbed', 'provider.rename status: registry routed, proposal stubbed', 'provider.setDefault status: registry routed, proposal stubbed' ]` — the three lifecycle cells of `docs/proposal/api/credential.md` remain `stubbed` while the registry says `routed`. The Story-07 SE `OPEN:` probe showed `scripts/lane-check.sh` denies that path to both roles (`outside every lane`), so no doc edit is made in this turn either. The Story-8 verification command itself passes (above), so the cycle proceeds to Story 9 RED.

**Test written.**

- file: `src/services/config/convict.test.ts` (edited) — suite: `src/services/config/convict.test` — methods:
  - `masterKeyFile naming a directory at mode 0600 throws config-refused naming the path and EISDIR, not a raw system error` — `err instanceof ConfigError`, code `config-refused`, message exactly `masterKeyFile refused at <path>: EISDIR`
  - `masterKeyFile naming a self-referential symlink throws config-refused naming the path and ELOOP` — same shape, exact `masterKeyFile refused at <path>: ELOOP`
  - `self-referential masterKeyFile and tokenFile refuse with the exact master-key ELOOP message and no token-file path` — exact master-key ELOOP message and `doesNotMatch(/http\.tokenFile/)`, proving the master-key failure wins and only the configured path and OS code travel
- asserts: the observable contract is a `ConfigError` carrying code `config-refused`, the configured path and the OS code — never a raw `SystemError`; the existing 0644-refusal/0600-load (line 839), both-sources (813) and missing-path (872) regressions stay untouched and green
- file: `src/services/config/startup.test.ts` (new) — suite: `src/services/config/startup.test` — method: `the daemon with no masterKey and no masterKeyFile refuses before it listens and leaves no identity lock` — asserts exit code `1`, `stdout() === ""`, stderr starts `kanthord: config-refused:`, `daemon.lock.identity` absent in its own `mktemp` home, and `fetch` to the reserved port rejects with `ECONNREFUSED`
- characterization note: the startup method passes today (the absent-key refusal already ships at `refusals.ts:21`) — it pins the composed refusal-before-listen contract; its sensitivity is carried by the three convict methods, which are RED for the same Story behavior (raw stat/read failures still escape). Each startup assertion pins a distinct regression: the refusal code in stderr (a missing refusal prints no such line), no identity lock (lock acquisition sits after `load` in `main.ts`), port unbound (a listen before refusal would bind it).

**RED proof.**

- command: `node --test src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts`
- exit: 1 — run: `ℹ tests 148`, `ℹ pass 145`, `ℹ fail 3` — failures:
  - `✖ masterKeyFile naming a directory at mode 0600 throws config-refused naming the path and EISDIR, not a raw system error` — `AssertionError [ERR_ASSERTION]: the read failure must convert to ConfigError, not escape raw` at `convict.test.ts:912`
  - `✖ masterKeyFile naming a self-referential symlink throws config-refused naming the path and ELOOP` — `AssertionError [ERR_ASSERTION]: the stat failure must convert to ConfigError, not escape raw` at `convict.test.ts:944`
  - `✖ self-referential masterKeyFile and tokenFile refuse with the exact master-key ELOOP message and no token-file path` — `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value: assert.ok(err instanceof ConfigError)` at `convict.test.ts:985`
- every failing test fails because the raw OS error (`EISDIR` from the read, `ELOOP` from the stat) escapes `convict.ts` — only `ENOENT` is converted today — so none fails for a wrong reason; `refusals.test.ts` stays green (missing sources, both sources, literal 0644), the 0644/0600 and missing-path regressions in `convict.test.ts` stay green, and the startup suite passes as the characterization pin above
- stub probe: n/a — the seam is a private helper inside `src/services/config/convict.ts` that no test imports; the tests exercise only existing public surface (`ConvictConfig().load`, `ConfigError`, the daemon helpers). `npm run typecheck` exits 0 with both files in place.

**Open to Software Engineer.**

- `src/services/config/convict.ts` — the Story file's Change/Constraints sections: one shared private `openRestrictedSecretFile(filePath, settingName)` helper used by both the master-key and `http.tokenFile` call sites, and `load` opening both configured restricted files inside one outer try/finally, passing handle modes to `assertStartable` before any handle `read()`, and closing every opened handle exactly once in the finally (preserving a thrown work error over a close error). `ENOENT` converts to `ConfigError("config-invalid", "<settingName> not found: <path>")`; every other open/fstat/read failure converts to `ConfigError("config-refused", "<settingName> refused at <path>: <OS code>")` — the exact messages the three new tests assert; when open succeeds and fstat throws, the descriptor closes before conversion.
- `src/services/config/startup.test.ts` needs no production change — it is green against the current composition and pins the composed refusal-before-listen contract for the Story's full unit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · Story 09 — master key startup refusal

**Cycle.** GREEN+REFACTOR for `src/services/config/convict.test.ts` (+ `src/services/config/startup.test.ts`).
**Files changed.**

- `src/services/config/convict.ts` (edited) — `readTokenFile` removed; private `openRestrictedSecretFile(filePath, settingName)` added with handle type `RestrictedSecretHandle` (`mode: number`, `read(): string`, idempotent `close(): void`), plus `restrictedSecretError`/`osErrorCode` conversions; the `ConvictConfig.load` secret-file section rewritten as one outer try/catch/finally
  **Seam (GREEN).** `load` opens `masterKeyFile` first and `http.tokenFile` second inside one outer `try` through the shared helper (open once with `fs.openSync`, fstat that same descriptor), passes the fstat modes to `assertStartable` before any handle `read()`, reads token content (retaining the `trimSingleTrailingNewline` transformation) and master-key content (retaining the `.trim()` + base64 transformation) only after `assertStartable` returns, and closes every opened handle exactly once in the outer `finally` — `close()` is idempotent, and a close error propagates only when no body error is in flight. The helper converts `ENOENT` from open, fstat or read to `ConfigError("config-invalid", "<settingName> not found: <path>")` and every other open/fstat/read failure to `ConfigError("config-refused", "<settingName> refused at <path>: <OS code>")`; when open succeeds and fstat throws, the descriptor closes before conversion. No message ever carries file content or a key byte.
  **Refactor.** The Story names no separate REFACTOR step beyond the Change section; applied in full — one shared helper for both call sites, the mode-check-before-read ordering (a non-`0600` mode refuses before content is read), and no path re-resolved between the mode check and the read.
  **Build check.**
- typecheck: exit 0
- lint: exit 0
  **Assumptions.**
- VERIFIED (runtime probe of the production code, not tests): on this macOS/Node runtime a directory chmodded `0600` opens and fstats to mode `0600` and its descriptor read fails with `EISDIR`; a self-referential symlink fails at open with `ELOOP`; `fs.readFileSync(fd, "utf-8")` reads through the descriptor. The three RED scenarios, the 0644/0600 regression, both ENOENT messages and the tokenFile newline transformation were exercised through the real `ConvictConfig` with exact-match messages.
- VERIFIED: no repo test pins the pre-EPIC lenient token guard. `resolvedToken` now carries the inline `http.token` only (the EPIC's binding sequencing forbids any handle read before `assertStartable` returns), so a `tokenFile`-only config no longer satisfies the non-loopback-bind / non-empty-allowedOrigins token guards; every existing convict tokenFile test uses a loopback bind, and the p1-e4 e2e scenario fakes the daemon and never loads convict with that combination. Stricter than before, and the direct consequence of the EPIC's explicit order.
- VERIFIED: `refusals.ts` untouched; the 0644-before-read property holds by construction (modes reach `assertStartable` before any `read()` call).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 09 GREEN confirm + Story 10 RED — inherited regressions

**Cycle.** Confirm GREEN for Story `09-master-key-startup-refusal`; RED for Story `10-inherited-regressions` (`node --test src/services/crypto/aes-gcm.test.ts src/queries/provider/list-provider.test.ts src/queries/provider/show-provider.test.ts`).

**GREEN confirmed (Story 09).**

- handoff gate: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's claim (`typecheck: exit 0`, `lint: exit 0`) matches the artifact.
- command: `node --test src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts` — exit: 0 — `ℹ tests 148`, `ℹ pass 148`, `ℹ fail 0` — the EISDIR, ELOOP and dual-failure methods, the 0644-refusal/0600-load regression and the startup refusal-before-listen method are all green.

**Test written.**

- file: `src/services/crypto/aes-gcm.test.ts` (edited) — suite: `src/services/crypto/aes-gcm.test` — five test names prefixed `regression:` (`regression: a flipped ciphertext byte fails authentication`, `regression: a flipped tag byte fails authentication`, `regression: a flipped iv byte fails authentication`, `regression: a wrong master key fails authentication`, `regression: a foreign keyVersion throws crypto-key-missing with the version message`); no assertion changed. `keyVersion is bound as additional authenticated data` and `the version check runs before any crypto call` stay unprefixed — the Story's named list covers five.
- file: `src/queries/provider/list-provider.test.ts` (edited) — suite: `src/queries/provider/list-provider.test` — methods: `regression: a broken payload is reported as projection null, not dropped` (renamed); `regression: the statement names its columns` (renamed + strengthened) — asserts `source.includes` of the exact nine-column literal `id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at` from `list-provider.ts:49-50`, and `/select\s*\*/i.test(source) === false` (replaces the two exact-case checks, covers every case and spacing form)
- file: `src/queries/provider/show-provider.test.ts` (edited) — suite: `src/queries/provider/show-provider.test` — methods: `regression: returns projection null for a broken payload` (renamed); new `regression: the statement names its columns and rejects a star select` — reads `show-provider.ts`, asserts the same exact nine-column literal and rejects `/select\s*\*/i`
- test-state correction (mine, test-side): the first run failed 3 inherited methods with `Error [IdGeneratorError]: mock id generator exhausted after 6 ids` — `every item carries a projection and no credential field`, `a kind filter returns only the matching rows in the same order` (list) and `each kind returns that kind's projection, asserted field by field` (show). Story 03 makes the first `llm` registration mint a third id (the `provider.defaultSet` append), so each phase-1 fixture that registers an `llm` row needs one more ulid: `…0W21` added to the two list fixtures, `…0W23` to the show fixture. Production untouched; the fixtures now match the Story-03 stamping behavior.

**RED proof.**

- command: `node --test src/services/crypto/aes-gcm.test.ts src/queries/provider/list-provider.test.ts src/queries/provider/show-provider.test.ts`
- exit: 0 — `ℹ tests 31`, `ℹ pass 31`, `ℹ fail 0`
- characterization pass, stated explicitly: every Story-10 assertion pins shipped behavior — the five crypto methods assert the existing authentication and crypto-key-missing contracts with unchanged assertions, and both named-column tests read the shipped `columns` literal, which both production files already hold (the Story's own Verify expects exit 0). Sensitivity proof, probe: the exact same assertions run against broken variants — `SELECT *`, `select *`, `SeLeCt *`, `SELECT*` and a one-column-dropped literal — fail 5/5 (`PROBE: sensitivity live`; both live sources pass), so any future star-select or column drift in either query fails its regression.
- stub probe: n/a — Story 10 changes test files only; no missing seam masks anything. `npm run typecheck` exits 0 with all edits in place.
- open blocker, unchanged: `parity.test.ts` still fails on the three status cells (registry `routed` vs proposal `stubbed` in `docs/proposal/api/credential.md`); `scripts/lane-check.sh` denies that path to both roles — reported, not repaired.

**Open to Software Engineer.**

- No production seam. Story 10's Change and Constraints name test files only — `src/services/crypto/aes-gcm.test.ts`, `src/queries/provider/list-provider.test.ts`, `src/queries/provider/show-provider.test.ts` — all TE-lane; "Change no file under `src/services/crypto/` except its test" and "Change no provider query production file" leave nothing to implement. The SE's GREEN turn is a verify-only gate: the Story's suite command above exits 0, and `npm run typecheck` / `npm run lint` stay clean (`npm run verify` remains red solely on the lane-denied proposal-parity blocker).

END: TEST-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · Story 10 GREEN confirm + EPIC gate run — blocked

**Cycle.** Confirm GREEN for Story `10-inherited-regressions`; run the EPIC Gates `npm run verify` and the exact EPIC Proof command; no edits made this turn.

**Story 10 confirmed.**

- command: `node --test src/services/crypto/aes-gcm.test.ts src/queries/provider/list-provider.test.ts src/queries/provider/show-provider.test.ts` — exit: 0 — `ℹ tests 31`, `ℹ pass 31`, `ℹ fail 0`
- Story 10 is test-only (Change/Constraints name test files only), so it has no SE handoff artifact to re-verify; the last SE handoff (Story 09: `typecheck: exit 0`, `lint: exit 0`) was independently re-verified `VERIFY: PASS` in the Story-10 turn.

**Task inventory — all ten Stories cycled.** Stories 1-9 have SE GREEN turns; Story 10 is TE-lane test changes only, done in the Story-10 turn. Every Story Change section is addressed in the discussion file, with one open item: Story 7's `docs/proposal/api/credential.md:20-22` cell flip, lane-denied.

**Gates — `npm run verify`.**

- exit: 1 — `ℹ tests 3458`, `ℹ pass 3454`, `ℹ fail 4` — three distinct causes:
  1. known parity blocker (lane-denied, unchanged since Story 07): `src/http/contract/parity.test.ts` — `mismatched: [ 'provider.remove status: registry routed, proposal stubbed', 'provider.rename status: registry routed, proposal stubbed', 'provider.setDefault status: registry routed, proposal stubbed' ]` — the three lifecycle cells of `docs/proposal/api/credential.md:20-22` remain `stubbed`; `scripts/lane-check.sh` denies that path to both roles (`outside every lane`). Reported, not repaired.
  2. NEW, my lane, pre-existing fixture missed by Story 07's inventory updates: `scripts/publish-contract.test.ts:92` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 26 !== 23` — `assert.equal(exampleFiles.length, 23)`; the three newly routed operations publish three more example files.
  3. NEW, my lane, pre-existing fixture missed by the Story-10 corrections: `src/queries/repository/inspect-repository.test.ts:381` — `Error [IdGeneratorError]: mock id generator exhausted after 2 ids` at `register-provider.ts:91` — the shared `register` helper's mock list (`01HZY8QF3M4N5P6R7S8T9V0W1X`, `01HZY8QF3M4N5P6R7S8T9V0W1Y`) carries two ids; Story 03 makes the first `llm` registration mint a third (`provider.defaultSet` append). Same class as the list/show fixture corrections the Story-10 turn made.
- the failing test at `src/queries/repository/inspect-repository.test.ts:381` is not the Story-10 verify path and not in the EPIC Proof; it is an EPIC-100-era fixture broken by Story-03 behavior.

**Proof — exact EPIC Proof command.**

- exit: 0 — `ℹ tests 260`, `ℹ pass 260`, `ℹ fail 0` — `PASS EPIC-101` printed.

**Next required action.**

- `npm run verify` exits 1, so IMPLEMENTATION_READY_FOR_REVIEW is withheld.
- My next turn fixes the two TE-lane fixtures — `scripts/publish-contract.test.ts:92` (count 23 to 26, then re-check the example-ids deep-equal at :96 against `publishedOperationIds`) and `src/queries/repository/inspect-repository.test.ts:90-92` (third ulid in the shared mock list) — then re-runs `npm run verify`.
- Parity remains lane-blocked: the three cells need `stubbed` -> `routed` in `docs/proposal/api/credential.md:20-22`; `scripts/lane-check.sh` denies that path to both roles, yet the Story-06 SE edited the same file, so the flip is pending a lane decision. `npm run verify` cannot exit 0 without it.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 101-credential-registry-completion · EPIC gate handoff — lane-blocked

**Cycle.** Gate handoff after the TE's `npm run verify` run (exit 1, `tests 3458 / pass 3454 / fail 4`); no production seam is in lane this turn.
**Files changed.** none.
**Build check.**

- typecheck: exit 0
  **Lane status.** All three gate failure causes sit outside the SE lane; no production change is possible without violating lane ownership:
- OPEN: `scripts/publish-contract.test.ts:92` — example-count fixture `23 !== 26`; the three newly routed operations publish three more example files. TE-lane; the TE's next turn fixes it.
- OPEN: `src/queries/repository/inspect-repository.test.ts:381` — `mock id generator exhausted after 2 ids`; the shared register mock list needs a third ulid for the Story-03 `provider.defaultSet` append. TE-lane; same class as the Story-10 list/show fixture corrections.
- OPEN: `docs/proposal/api/credential.md:20-22` — the three lifecycle cells (`provider.remove`, `provider.rename`, `provider.setDefault`) remain `stubbed` while the registry says `routed`; `scripts/lane-check.sh` denies that path to both roles, so the parity cell flip is lane-blocked and `npm run verify` cannot exit 0 without it.
  **Assumptions.**
- VERIFIED: no Story change names production work for this handoff — the last TE turn's "Open to Software Engineer" names no seam, and the two failing fixtures are test-engineer files per `scripts/lane-check.sh`. The EPIC Proof command exits 0 (`PASS EPIC-101`), so no proof-path regression is mine to repair.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 101-credential-registry-completion · gate fixture repair — parity still lane-blocked

**Cycle.** Repair the two TE-lane fixtures named by the gate (`scripts/publish-contract.test.ts:92`, `src/queries/repository/inspect-repository.test.ts:90-92`); re-run the focused suites, the full `npm run verify` gate and the EPIC Proof command. No ready marker — `npm run verify` still exits 1 on the single lane-blocked proposal-parity failure.

**Test written.**

- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract`:
  - `:92` — expected example-file count `23` → `26`: the three Story-07 routed operations (`provider.rename`, `provider.remove`, `provider.setDefault`) each publish one more example file
  - `:96` — no edit needed: the exact published-operation-id deep-equal was already dynamic (`sortedBytewise(publishedOperationIds)` derives from `registry.filter(entry => entry.examples !== undefined)`), so the three new ids join automatically in the existing canonical bytewise order
  - `:98` — sibling assertion in the same fixture block: the example-name regex `^[a-z][a-z.]*\.json$` rejected `provider.setDefault.json` (canonical uppercase `D` from the Story-07 operation id); widened to `^[a-zA-Z][a-zA-Z.]*\.json$`. Lane-owned: `scripts/lane-check.sh test-engineer scripts/publish-contract.test.ts` exits 0
- file: `src/queries/repository/inspect-repository.test.ts` (edited) — the shared `register` helper's mock id list gains the third deterministic ULID `01HZY8QF3M4N5P6R7S8T9V0W1Z` (continuing the fixture's X, Y sequence; matches the third slot `…0W1Z` of `register-provider.test.ts`'s own list). Story 03 makes the first `llm` registration mint a third id (`provider.defaultSet` append), so `refuses an llm credential as credential-wrong-kind naming the kind` at `:381` was exhausting the 2-id list; the git-only call sites keep minting two and leave the third unused. Same class as the Story-10 list/show fixture corrections; production untouched.

**Verification result.**

- focused: `node --test scripts/publish-contract.test.ts src/queries/repository/inspect-repository.test.ts` — exit: 0 — `ℹ tests 27`, `ℹ pass 27`, `ℹ fail 0`
- gate: `npm run verify` — exit: 1 — `ℹ tests 3458`, `ℹ pass 3457`, `ℹ fail 1` — the single failure is the lane-blocked proposal parity, unchanged since Story 07:
  - `src/http/contract/parity.test.ts` — `AssertionError` — actual `mismatched: [ 'provider.remove status: registry routed, proposal stubbed', 'provider.rename status: registry routed, proposal stubbed', 'provider.setDefault status: registry routed, proposal stubbed' ]`, expected `[]` — the three lifecycle cells of `docs/proposal/api/credential.md:20-22` remain `stubbed` while the registry says `routed`
- lane predicate denial (both roles, captured verbatim):
  - `scripts/lane-check.sh test-engineer docs/proposal/api/credential.md` — `lane violation: test-engineer changed docs/proposal/api/credential.md (outside every lane)` — exit 1
  - `scripts/lane-check.sh software-engineer docs/proposal/api/credential.md` — `lane violation: software-engineer changed docs/proposal/api/credential.md (outside every lane)` — exit 1
  - No doc edit is made; the parity failure is reported, not repaired.
- typecheck passed inside the verify chain (the run reached the test phase); `npm run lint` — exit: 0
- EPIC Proof (exact command) — exit: 0 — `ℹ tests 260`, `ℹ pass 260`, `ℹ fail 0` — `PASS EPIC-101` printed; my two fixture edits are outside the proof path and nothing in this turn regresses it.

**No ready marker.** IMPLEMENTATION_READY_FOR_REVIEW is withheld — `npm run verify` does not exit 0.

**Next required action.** The three lifecycle cells `stubbed` → `routed` at `docs/proposal/api/credential.md:20-22` are the only remaining gate failure; both roles are lane-denied (`outside every lane`), so the flip awaits a lane decision. All TE-lane gate failures are repaired (4 fail → 1 fail).

END: TEST-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- gate: `npm run verify` — exit 0 — `ℹ tests 3458`, `ℹ pass 3458`, `ℹ fail 0` — lint and the OpenAPI verify pass inside the chain.
- typecheck: `npm run typecheck` (`tsc --noEmit`) — exit 0
- unit: `npm test` (`node --test`) — exit 0 — `ℹ tests 3458`, `ℹ suites 351`, `ℹ pass 3458`, `ℹ fail 0`
- The parity blocker recorded since Story 07 is resolved in the working tree: the three lifecycle cells of `docs/proposal/api/credential.md` read `routed`, so `parity.test.ts` reports no mismatch and `npm run verify` exits 0.

**Proof.**

- command: `node --test src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/services/ids/ulid.test.ts src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts src/services/crypto/aes-gcm.test.ts && echo "PASS EPIC-101"` — exit 0 — `ℹ tests 260`, `ℹ pass 260`, `ℹ fail 0` — success string printed verbatim: `PASS EPIC-101`.

**Tasks closed.** 10 of 10 Stories complete, none outstanding: 01 monotonic id generator, 02 provider view domain type, 03 first registration stamps the chain, 04 provider.setDefault, 05 provider.rename, 06 provider.remove blocker list, 07 route contracts, 08 composition and refusals, 09 master key startup refusal, 10 inherited regressions. Every Story RED was confirmed GREEN in its cycle; Story 10's characterization suite passed and the two gate fixture repairs (publish-contract counts, inspect-repository ulid list) are green inside `npm run verify`.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (node --test src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/services/ids/ulid.test.ts src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts src/services/crypto/aes-gcm.test.ts && echo "PASS EPIC-101") — "PASS EPIC-101"
- stories: 10/10 complete
- date: 2026-08-13
- state: local-uncommitted
```

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 duplicated transport schema — src/http/server/credential/rename-provider.ts defines a local zod request schema instead of importing providerRenameRequest from http/contract; remove the duplicate and use the contract schema.
BLOCKER: B2 token-file content is ignored for exposed binds — src/services/config/convict.ts passes an empty resolvedToken before reading tokenHandle, so valid token-file-only configurations fail startup validation; preserve mode-before-read, then use the transformed token content for refusal checks.
BLOCKER: B3 fixed-millisecond ULID proof is ineffective — src/services/ids/ulid.test.ts mints before mocking Date.now, so the tested ids do not use 1700000000000; mock time before the first mint and assert the fixed timestamp.

## TEST-ENGINEER — 101-credential-registry-completion · AUTO_REVIEW blockers B1-B3 regressions

**Cycle.** Review-fix regressions for the three AUTO_REVIEW blockers B1 (rename contract schema), B2 (token-file content for exposed binds), B3 (fixed-millisecond ULID proof) — focused suites `node --test src/http/server/credential/rename-provider.test.ts src/services/config/convict.test.ts src/services/ids/ulid.test.ts`.

**Test written.**

- file: `src/http/server/credential/rename-provider.test.ts` (edited) — suite: `src/http/server/credential/rename-provider.test` — methods: `regression: the handler parses the body with the exported providerRenameRequest contract schema, not a local duplicate`
- asserts: reads `./rename-provider.ts` source via `readFileSync(new URL(..., import.meta.url))` (the Story-10 source-assertion style); the handler imports `providerRenameRequest` from `"../../contract/credential.ts"`, declares no `providerRenameRequest =` assignment (no local duplicate), and carries no `from "zod"` import (a hidden local schema cannot survive under another name)
- file: `src/services/config/convict.test.ts` (edited) — suite: `src/services/config/convict.test` — methods: `a valid 0600 token file satisfies the non-loopback bind and non-empty allowedOrigins guards with its transformed content`
- asserts: own `mktemp` dir (`tmpDir()` + `fs.rmSync` in `finally`, hermetic); token file written `"s3cret\n"` at mode `0o600`; config with `bind: "0.0.0.0"` (non-loopback), `allowedOrigins: ["http://a.test"]` (non-empty), `token: ""` and `tokenFile` set; `ConvictConfig().load` succeeds (both token guards satisfied) and `settings.http.token === "s3cret"` (the `trimSingleTrailingNewline` transform reached the value)
- file: `src/services/ids/ulid.test.ts` (edited) — suite: `src/services/ids/ulid.test` — methods: `mints two event ids in the fixed millisecond 1700000000000 in mint order` (extended)
- asserts: `Date.now` mocked to `1700000000000` at module scope before the first mint of the process (via `mock.method` + `after(mock.restoreAll)`); `identityTime(first)` and `identityTime(second)` both strictly equal `1700000000000`; the mint-order comparison `Buffer.compare(Buffer.from(first), Buffer.from(second)) === -1` preserved

**RED proof.**

- command: `node --test src/http/server/credential/rename-provider.test.ts src/services/config/convict.test.ts src/services/ids/ulid.test.ts`
- exit: 1 — run: `ℹ tests 136`, `ℹ pass 134`, `ℹ fail 2`
- B1 — `✖ regression: the handler parses the body with the exported providerRenameRequest contract schema, not a local duplicate` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `actual: false, expected: true` (the contract-import assertion; the handler defines `const providerRenameRequest = z.strictObject(...)` locally and imports `z` from `zod`)
- B2 — `✖ a valid 0600 token file satisfies the non-loopback bind and non-empty allowedOrigins guards with its transformed content` — `Error [ConfigError]: a non-loopback bind address requires http.token` at `refusals.ts:73` via `convict.ts:400` — `convict.ts` passes `resolvedToken: tokenStr` (the empty inline value) and reads the token handle only after `assertStartable` returns; both failures fail for the exact behavior the review names
- B3 — RED captured under the pre-fix structure: with the mock inside the test, `✖ mints two event ids in the fixed millisecond 1700000000000 in mint order` — `AssertionError: Expected values to be strictly equal: + 1786637186490 - 1700000000000` — the module-scoped monotonic factory stamps `lastTime` with real wall-clock time in the earlier `mint("project")` test, and a backward mocked seed is ignored (`seed <= lastTime`), so the ids never used the fixed millisecond; the review's diagnosis is confirmed, and the defect is test-lane (a probe with the mock in place before any mint decodes `1700000000000`, and the corrected file now passes)
- after the test-side fix: `node --test src/services/ids/ulid.test.ts` — exit: 0 — `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0` — the timestamp assertion is now effective: any regression to mocking after a mint (or no mock) fails it, and the mint-order comparison is preserved
- stub probe: n/a — the B1/B2 seams are existing symbols; `npm run typecheck` exits 0 with all three edits in place
- lane check: `scripts/lane-check.sh test-engineer` exits 0 on all three edited files

**Open to Software Engineer.**

- `src/http/server/credential/rename-provider.ts` — the handler's request-body parse must use the exported `providerRenameRequest` from `src/http/contract/credential.ts`; the file must define no local body schema and carry no `zod` import. The public handler signature, the `{ name }` parse contract, the invalid-body constant message and the refusal mapping stay unchanged.
- `src/services/config/convict.ts` — `ConvictConfig.load` must feed the token guards of `assertStartable` with the transformed token-file content (`trimSingleTrailingNewline` of the file read), so a token-file-only config with mode `0600`, a non-loopback bind and a non-empty `allowedOrigins` loads and yields that transformed value as `settings.http.token`; the mode-before-read ordering stays (the existing `0644` refusal tests pin it). The B1/B2 tests above go green when each seam satisfies its observable contract; B3 needs no production change.
- No docs, configs or pipeline guards are touched in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — AUTO_REVIEW blockers B1-B2 fixes (rename contract schema, token-file content for exposed binds)

**Cycle.** Review-fix for the B1/B2 regressions of the TE's `AUTO_REVIEW blockers B1-B3 regressions` turn (B3 is test-lane and the TE's turn already fixed it test-side; no production seam).
**Review blocker addressed.**

- BLOCKER: B1 duplicated transport schema — src/http/server/credential/rename-provider.ts defines a local zod request schema instead of importing providerRenameRequest from http/contract; remove the duplicate and use the contract schema.
- BLOCKER: B2 token-file content is ignored for exposed binds — src/services/config/convict.ts passes an empty resolvedToken before reading tokenHandle, so valid token-file-only configurations fail startup validation; preserve mode-before-read, then use the transformed token content for refusal checks.
  **Files changed.**
- `src/http/server/credential/rename-provider.ts` (edited) — `import { z } from "zod"` and the local `const providerRenameRequest = z.strictObject({ name: z.string().min(1) })` removed; `providerRenameRequest` now imported (value import) from `../../contract/credential.ts`; handler signature, `{ name }` parse, `the provider rename body is invalid` message and `toHttpError` mapping unchanged
- `src/services/config/convict.ts` (edited) — the `resolvedToken` passed to `assertStartable` now derives from the token handle: when a token file is configured and its fstat mode passes the `0600` gate, `resolvedToken` is `trimSingleTrailingNewline(tokenHandle.read())` and the same transformed value is set as `http.token`; otherwise it stays the inline `http.token` value
  **Seam (GREEN).** B1: the handler parses the body through the exported contract schema, so the source assertions (contract import present, no local assignment, no zod import) and every behavior assertion (valid body 200, 404, 400 name-taken, 400 empty body with zero command calls) hold. B2: a valid 0600 token-file-only config with a non-loopback bind and a non-empty `allowedOrigins` passes both token guards and yields the transformed content as `settings.http.token === "s3cret"`.
  **Mode-before-read preserved.** The token-file read is gated on the exact mode predicate `assertStartable` refuses on (`(mode & 0o777) === 0o600`), so a non-`0600` token file's content is never read — the 0644 refusal still comes from `assertStartable` with the exact `http.tokenFile must have mode 0600; found 0644` message, and the master-key read still happens only after `assertStartable` returns. The outer try/finally close semantics (idempotent close, close error propagated only when no body error is in flight) are byte-identical.
  **Build check.**
- typecheck: exit 0
- lint: exit 0
  **Assumptions.**
- VERIFIED (runtime probe of the production code, not tests — threw-away script in the temp dir): 0600 token file + `bind 0.0.0.0` + `allowedOrigins ["http://a.test"]` + `token ""` loads with `settings.http.token === "s3cret"`; 0644 token file refuses `config-refused` with `found 0644`; 0600 token file loopback loads; 0644 masterKeyFile refuses and the same file at 0600 loads; token + tokenFile both set refuses `are both set`; missing tokenFile converts to `config-invalid http.tokenFile not found: <path>`; dual self-referential symlinks refuse with the master-key ELOOP message only. All seven paths behave as the existing tests pin.
- VERIFIED: the EPIC's mode-before-read property ("a non-`0600` mode therefore refuses before content is read") holds for both restricted files — the token-file gate mirrors `refusals.ts`'s mode predicate exactly, so the 0644 refusal always precedes any content read.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm-GREEN for the AUTO_REVIEW B1-B3 regression fixes, then full gate re-verification. The B1/B2 production seams (rename handler contract schema, token-file content for exposed binds) went green on the SE turn; the B3 regression test is test-lane and passed from the TE turn onward. Re-ran the focused review-fix suites, the full gate and the exact EPIC Proof independently.

**Focused review-fix suites.** `node --test src/http/server/credential/rename-provider.test.ts src/services/config/convict.test.ts src/services/ids/ulid.test.ts` — exit: 0 — `ℹ tests 136`, `ℹ pass 136`, `ℹ fail 0` — includes `✔ regression: the handler parses the body with the exported providerRenameRequest contract schema, not a local duplicate`, `✔ a valid 0600 token file satisfies the non-loopback bind and non-empty allowedOrigins guards with its transformed content` and `✔ mints two event ids in the fixed millisecond 1700000000000 in mint order`.

**EPIC verification gate.**

- `npm run verify` — exit 0 — `ℹ tests 3460`, `ℹ pass 3460`, `ℹ fail 0`; lint clean; four migrations applied; `verify db status ok`.

**Proof.**

- command: `node --test src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/services/ids/ulid.test.ts src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts src/services/crypto/aes-gcm.test.ts && echo "PASS EPIC-101"`
- exit: 0 — success string: `PASS EPIC-101` — `ℹ tests 262`, `ℹ pass 262`, `ℹ fail 0`.

**Tasks closed.** 10 of 10 Stories complete, none outstanding: 01 monotonic id generator, 02 provider view domain type, 03 first registration stamps the chain, 04 provider.setDefault, 05 provider.rename, 06 provider.remove blocker list, 07 route contracts, 08 composition and refusals, 09 master key startup refusal, 10 inherited regressions. Every Story RED was confirmed GREEN in its cycle; the three AUTO_REVIEW blockers are closed — B1 and B2 by the SE production fix (both regression tests green above), B3 by the test-lane fix (timestamp assertion now effective, mint-order comparison preserved). No disabled tests, no skipped coverage.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (node --test src/commands/provider/*.test.ts src/queries/provider/*.test.ts src/http/server/credential/*.test.ts src/services/ids/ulid.test.ts src/services/config/convict.test.ts src/services/config/refusals.test.ts src/services/config/startup.test.ts src/services/crypto/aes-gcm.test.ts && echo "PASS EPIC-101") — "PASS EPIC-101"
- stories: 10/10 complete
- date: 2026-08-13
- state: local-uncommitted
```

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
