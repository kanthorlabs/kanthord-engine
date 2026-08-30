# EPIC 045 — Subscription authentication for LLM providers — stories

Epic: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`
Prereq: EPIC 044 (sequence order).

A human signs in to an LLM provider with a subscription account: the engine drives
`pi-ai`'s OAuth flow, a login returns the challenge that vendor emits, a second request
completes it, and the credential is encrypted at rest, refreshed by the library, and never
returned.

## Dispatch order

1. `01-path-grammar-login-segments.md` — two closed-set members (no operation yet)
2. `02-payload-oauth-variant.md` — the stored payload union and both projections
3. `03-provider-login-migration.md` — migration 0010, the domain row, `rows.ts`, the proposal fence
4. `04-oauth-vendor-set-and-method-rule.md` — the derived vendor set and `chooseOptionId`
5. `05-suspended-login-adapter.md` — `startLogin` / `completeLogin` / `abortLogin`
6. `06-credential-store-write-path.md` — the store reads and writes oauth; the refresh event
7. `07-login-commands.md` — the three commands
8. `08-register-oauth-arm.md` — registration consumes a completed login
9. `09-catalog-oauth-capability.md` — the catalogue `oauth` member
10. `10-contract-operations.md` — the three operations and every pinned count
11. `11-handlers-refusals-and-wiring.md` — the handlers, refusals and `main.ts`
12. `12-proposal-documents.md` — the proposal record

Story 4 comes before Story 5 because the adapter answers a `select` through
`chooseOptionId`. Story 3 comes before Story 7 because the commands write the table.
Stories 10, 11 and 12 are sequential: the contract declares the operations, the handlers
bind them, and the proposal matrix must equal the registry. **Stories 10 and 12 must land
in the same change** — `parity.test.ts` compares the registry to the proposal matrix and
fails in both directions if only one lands.

Stories 4 and 9 both derive the vendor set, independently and deliberately; neither imports
the other.

### Each story must be green on its own, and three of them are not by default

Every story's Verify block runs `npm run verify`, so each must leave the tree
type-checking. Three widenings break existing code the moment they land, and the story that
causes the break owns the fix:

- **Story 2** turns `LlmPayload` into a union. `register-provider.ts:49-72` and
  `verify-provider.ts` read `apiKey`/`baseUrl` with no narrowing. Story 2 narrows both —
  `verify-provider.ts` throws the existing `provider-not-verifiable` on the oauth arm as a
  temporary terminal state, which Story 6 replaces.
- **Story 4** adds `oauthVendors()` to `ProviderAuth`, and **Story 5** adds three more
  members. The `ProviderAuth` fakes in `src/queries/provider/verify-provider.test.ts` and
  `src/http/server/credential/verify-provider.test.ts` implement `probe` alone. Story 4
  introduces `test/helpers/provider-auth.ts` with `createFakeProviderAuth(overrides)` and
  repoints both files; Story 5 extends that one helper.
- **Story 10** imports `llmOauthRegisterPayload`, which **Story 8** creates. Story 10's
  dependency line now says so; do not run 10 before 8.

Story 6 also depends on **Story 5**, not on Story 2 alone: it edits
`PiAiProviderAuthDependencies` and the constructor that Story 5 reshapes.

## Stories

- 1 — `login` and `complete` join the closed segment sets → `01-path-grammar-login-segments.md`
- 2 — the stored `llm` payload becomes a transport union → `02-payload-oauth-variant.md`
- 3 — `provider_login` table, domain row and proposal fence → `03-provider-login-migration.md`
- 4 — the admitted vendor set and the method preference rule → `04-oauth-vendor-set-and-method-rule.md`
- 5 — the suspended-login adapter over `AuthInteraction` → `05-suspended-login-adapter.md`
- 6 — the credential store serves and persists an oauth credential → `06-credential-store-write-path.md`
- 7 — start, complete and cancel commands → `07-login-commands.md`
- 8 — `provider.register` consumes a completed login → `08-register-oauth-arm.md`
- 9 — `provider.catalog` reports the oauth capability → `09-catalog-oauth-capability.md`
- 10 — the contract operations and the widened register arm → `10-contract-operations.md`
- 11 — handlers, refusals and composition → `11-handlers-refusals-and-wiring.md`
- 12 — the proposal record → `12-proposal-documents.md`

## Facts (needed for implementation)

### The library, `@earendil-works/pi-ai@0.84.1`

Verified by reading and running the installed package. **This worktree has no
`node_modules`**; the pinned version resolves from a sibling worktree. Run `npm install`
here before implementing.

- Exactly seven builtin providers carry `auth.oauth`: `anthropic`, `github-copilot`,
  `kimi-coding`, `openai-codex`, `openrouter`, `radius`, `xai`. **The admitted set is six**:
  the EPIC intersects that with the catalogue, and `radius` is not catalogued (**B5**).
- `lazyOAuth` (`dist/auth/helpers.js:38-52`) copies `name`, `isSubscription` and
  `loginLabel` onto the wrapper. Reading them loads no flow module; only `login`,
  `refresh` and `toAuth` trigger the dynamic import.
- `isSubscription` is `undefined` for `openrouter` and `radius`, and `true` for the other
  five. `loginLabel` is set only on `kimi-coding`, `openrouter` and `xai`.
- `openai-codex` has **no** `auth.apiKey`. It is oauth-only, and today's probe guard
  (`src/services/provider-auth/pi-ai.ts:120-125`) rejects it.
- Only **two** flows ever issue a `select` prompt: `openai-codex`
  (`dist/auth/oauth/openai-codex.js:429-436`, ids `browser` / `device_code`) and `radius`
  (`dist/auth/oauth/radius.js:288-298`, ids `browser` / `device-code`). The
  underscore/hyphen split is real. The other five never offer a choice.
- Observed first interaction per vendor, with `fetch` blocked:
  `github-copilot` → a `text` prompt, message exactly
  `"GitHub Enterprise URL/domain (blank for github.com)"`, unconditional and unskippable;
  `openai-codex` and `radius` → their `select`; `anthropic` and `openrouter` → an
  `auth_url` notify **after binding a real loopback callback port**; `kimi-coding` and
  `xai` → an immediate device-code HTTP request. Five are pinnable hermetically: the first
  three by their prompt, and `kimi-coding` and `xai` by asserting they prompt nothing under
  a stubbed `globalThis.fetch`. Only `anthropic` and `openrouter` cannot be — no `fetch`
  stub prevents a socket listen (**S4**).
- `login(interaction)` takes **one** argument. Cancellation arrives as
  `interaction.signal`, required on `ProviderAuthInteraction`. `notify` is synchronous and
  returns `void`; the only awaitable suspension is a `prompt`.
- `OAuthCredential` is `{ type: "oauth", refresh, access, expires }` **plus an open index
  signature** (`dist/auth/types.d.ts:20-30`). `github-copilot` stores `availableModelIds`
  and `enterpriseUrl` on it. A schema that strips unknown keys breaks Copilot.
- `availableModelIds` is set by **`github-copilot` only** — see **S1**.
- `AuthEvent` `device_code` carries required `userCode` and `verificationUri`, and optional
  `intervalSeconds` and `expiresInSeconds`. `auth_url` carries required `url` and optional
  `instructions`. No flow emits `type: "info"`.
- `CredentialStore.modify(providerId, fn, options?)` is the only write path. `fn` returning
  `undefined` means leave unchanged; the promise resolves with the post-write credential.
- Import surface: every auth type comes from the **root** `"@earendil-works/pi-ai"`.
  `builtinProviders` and friends come from `"@earendil-works/pi-ai/providers/all"`.
  `"@earendil-works/pi-ai/oauth"` is a **type-only legacy compat** entry and carries none
  of these types. `dist/auth/oauth/*` has no exports entry — a deep import fails with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### The repository

- **A new table has four required sites**, not one: the migration, `src/domain/<table>.ts`,
  an entry in `src/domain/rows.ts` in sorted position, and
  `docs/proposal/database/<table>.md` with a sql fence.
  `src/services/storage/schema-parity.test.ts:65-80` asserts the migrated table set equals
  `Object.keys(rows)`, and the migration test compares the DDL to the fence through
  `proposalStatements` (`test/helpers/proposal.ts:8-27`).
- Migration convention is `migration-NNNN-<slug>.ts` with a co-located `.test.ts`; the
  highest applied version is **9** (`src/services/storage/migration-0009-one-branch.ts:4`).
  Export name is `migration00NNSlug`; `Migration.name` is `"00NN-slug"`.
- `Storage.transact` is **synchronous** and refuses a thenable result
  (`src/services/storage/connection.ts:90-101`). No `await` inside a transaction.
- Encrypted-column convention (`src/services/storage/migration-0001-core-entities.ts:13-25`):
  `payload_ciphertext`/`payload_iv`/`payload_tag` BLOB, `key_version` INTEGER, `CHECK`s
  pinning a 12-byte iv and a 16-byte tag, timestamps integer epoch ms, `) STRICT`.
- Partial-unique-index precedent: `run_one_active`
  (`src/services/storage/migration-0003-execution-and-journal.ts:46`).
- `eventTypes` (`src/domain/event-type.ts`) is bytewise sorted, and `eventPayloads`
  (`src/http/contract/event-payload.ts:71`) is exhaustive over it — a new event type is a
  compile error until its payload exists. `"provider.credentialRefreshed"` sorts **before**
  `"provider.defaultSet"`.
- `AppendEventInput.type` is a bare `string`; the exhaustiveness lives in the payload map.
- `identityKinds`/`identityPrefixes` (`src/domain/identity.ts:3-45`) must gain
  `providerLogin` → prefix `login`.
- **Pinned counts that move.** `path.test.ts:37-42` (subresource 16→17, action 23→24);
  `registry.test.ts:49` (70→73), `:53` (70→73), `:113` (17→20 with-request),
  `:137` (44→46 with-response), `:630` (30→33 POST policies), `:681` (29→32 memory);
  `parity.test.ts:16` (70→73), `:25` (74→77).
- Every `POST` must declare a non-`none` idempotency policy
  (`registry.test.ts:620-628`), and `memory` requires a non-empty `replayable`
  (`src/http/contract/registry.ts:277-286`).
- `isLegalPath` (`src/http/contract/registry.ts:319-366`): an `action` is terminal, and
  `subresource → parameter` is illegal. That is why the login id travels in the body.
- `src/main.test.ts:270-281` asserts the fixture map equals the routed set exactly. A new
  routed operation with no fixture fails two tests.
- `toHttpError` (`src/http/server/credential/refusals.ts:10-64`) is an `instanceof` chain
  ending in `throw error`. `HttpError` exposes `code`, not `kind`.
- `invalidRequestDetails` (`src/http/contract/error-details.ts:110-114`) admits any
  `refusal` string plus an optional `detail`, so no new error code is needed.
- `readRouteMatrix` (`test/helpers/proposal.ts:53-84`) parses every
  `docs/proposal/api/*.md` except `README.md` and `new-decisions.md`, taking five-cell
  table rows.
- Composition sites in `src/main.ts`: `instanceId` `:209`, `clock` `:228`, `storage` `:229`,
  `ids` `:247`, `events` `:250`, `crypto` `:353`, `catalog` `:358`, `providerAuth` `:359`,
  the provider handler block `:387-420`.

## Proof coverage — what the stories deliver, and what they do not

Every `node --test` path in the EPIC Proof block is delivered by a story. The Proof line
that named an unnumbered migration test now reads
`src/services/storage/migration-0010-provider-login.test.ts`, matching Story 3 (**B1**,
amended in the EPIC).

The EPIC's "hermetic coverage required beyond the Proof" list is delivered as amended. Four
of its bullets were rewritten in the EPIC because they could not be met as originally
worded; each is tracked above, and the reasons are:

- per-vendor option ids and prompt messages "for every admitted vendor" — five of seven are
  pinned (`openai-codex`, `radius`, `github-copilot` by prompt; `kimi-coding`, `xai` by
  promptlessness). `anthropic` and `openrouter` cannot be pinned hermetically (**S4**).
- "the derived set … asserted against the installed library" — delivered, but the catalogue
  half of it carries **six** vendors, not seven, because `radius` is not catalogued
  (**B5**).
- "reading it triggers no dynamic import" — the synchronous signature does not prove this;
  Story 4 adds a `load`-flag assertion that does.
- "a `ProviderView` deep-equal to the one it produces before this epic" — contradicted by
  the projection change and narrowed to decrypted plaintext plus the other fields (**B3**).
- "the operation declares `idempotency: memory` only to join a concurrent duplicate" — the
  memory store is bypassed when no `Idempotency-Key` is sent
  (`src/http/server/idempotency.ts:47-50`), so the join happens only for keyed duplicates;
  keyless safety comes from the `UPDATE … WHERE state = 'pending'` guard instead.
- "a failing refresh leaves the ciphertext byte-identical and appends no event" — Story 6
  tests this through a failing event append. Add a case where the **refresh itself**
  rejects, so the bullet is met by its own scenario rather than a proxy.
- the global token-leak assertion "searches each serialized response" — the stories assert
  it per response and per stored row rather than as one sweep across every operation. A
  single shared helper asserting the fixture token values are absent, called from each of
  the login, register, catalog and verify tests, would meet it literally.
- a `radius` complete → models → register path is not proved, and cannot be until **B5** is
  decided.

## Planning defects and open questions

Report to the human before `/work` starts. Every item is applied as written in the stories
unless the human decides otherwise.

- **B1** - status:FIXED - action:YES - proof-names-an-unnumbered-migration-test - The EPIC
  Proof block ran `src/services/storage/migration-provider-login.test.ts`, but every
  migration test in the tree carries its four-digit version
  (`migration-0009-one-branch.test.ts`), and `migrations.ts` orders by that number. -
  fix:Story 3 writes `src/services/storage/migration-0010-provider-login.test.ts`, and the
  EPIC Proof line now names that path. -
  why:Following the Proof literally breaks the established naming and hides the version.
  The Proof block is binding and is meant to be copy-pasteable, so a story cannot resolve
  this on its own: until the EPIC is edited, the Proof command names a file that does not
  exist and the gate cannot pass.
- **B2** - status:FIXED - action:YES - verification-does-not-cover-oauth-unchanged - The EPIC
  states "No change to verification … It covers an OAuth registration with no edit." Two
  facts contradict it: `ProviderAuthRow` has a required `apiKey`
  (`src/services/provider-auth/index.ts:17-22`) and `createStore` returns an `api_key`
  credential unconditionally (`pi-ai.ts:30-56`); and the probe refuses any vendor with no
  `auth.apiKey` (`pi-ai.ts:120-125`), which is exactly `openai-codex`. - fix:Story 6 makes
  `ProviderAuthRow` a transport union, makes the store serve either credential, and relaxes
  the probe guard; `verify-provider.ts` builds the union row. The probe, the verdict map and
  the response shape are untouched. - why:Without it `provider.verify` refuses every
  subscription registration, and the EPIC's "irrecoverable credential is visible" decision
  — which routes the dashboard to `provider.verify` — does not work.
- **B3** - status:FIXED - action:YES - projection-contradicts-the-deep-equal-guarantee - The
  EPIC requires the api-key projection to become
  `{ transport, provider, defaultModel, baseUrl }` **and** requires an api-key registration
  to produce a `ProviderView` deep-equal to the one it produced before this epic. Adding a
  field makes those mutually exclusive. - fix:Stories 2 and 8 add `transport` to the
  projection and narrow the deep-equal guarantee to the **decrypted payload plaintext** plus
  every `ProviderView` field other than `projection.transport`. The wording matters: AES-GCM
  uses a fresh IV per record (`docs/proposal/database/provider.md:5-19`), so two
  registrations of one payload never produce equal ciphertext — only plaintext can be
  byte-identical, and every "stored row bytes" phrase in the stories means exactly that. **A
  human must amend the EPIC's hermetic-coverage bullet**; a story cannot silently replace
  the EPIC's oracle. - why:The dashboard cannot tell an api-key registration from an oauth
  one without the field, and the plaintext guarantee is the one that protects existing data.
  If the human prefers the literal deep-equal, drop `transport` from the api-key projection
  and keep it on the oauth arm only.
- **B4** - status:FIXED - action:YES - a-204-contradicts-the-one-success-status-rule -
  `provider.loginCancel` answers `204`, and this breaks **two** existing assertions:
  `docs/proposal/api/README.md:159` states every route answers `200` and no route declares
  another status, and `src/http/contract/openapi.test.ts:227-234` asserts every authored
  `successStatus` equals `200` with the message "overrides the default success status". No
  registry entry sets a non-200 `successStatus` today. - fix:Story 10 sets
  `successStatus: 204` **and** amends the `openapi.test.ts` loop to exempt
  `provider.loginCancel`; Story 12 amends README:159. The alternative is `200` with an empty
  strict-object response, which keeps both invariants and costs the dashboard nothing. -
  why:The rule is normative and load-bearing for idempotency reasoning; breaking it needs an
  explicit decision, and it costs an edit to a guard test, which is exactly the kind of edit
  that must be authorised rather than discovered at build time.
- **B5** - status:FIXED - action:YES - radius-is-not-in-the-catalogue-and-cannot-register -
  Verified by running the library: `getBuiltinProviders()` returns 39 ids and
  `builtinProviders()` returns 40; the difference is `radius`.
  `PiAiModelCatalog.staticProviders` iterates the former
  (`src/services/model-catalog/pi-ai.ts:35`), so `radius` is absent from `provider.catalog`
  and `catalog.has("radius")` is `false`. Registration gates on `catalog.has`
  (`src/commands/provider/register-provider.ts:53`), so a `radius` login can complete and
  never register. `getBuiltinModels("radius")` also returns `[]`, so the model fallback is
  empty and `default-model-unknown` would refuse it even past the gate. - fix:Story 9
  asserts **six** catalogued oauth vendors, not seven, and pins `radius`'s absence.
  The human chooses one of: drop `radius` from the admitted set, contradicting the EPIC's
  explicit inclusion; or add `radius` to the catalogue, which changes the `provider.catalog`
  response for every consumer and still yields a vendor with zero models. - why:The EPIC
  states "radius is included", and as specified that promise cannot be kept. Three EPIC
  claims depend on it: the seven-vendor catalogue, the derived-set equality, and a working
  end-to-end `radius` registration.
- **B6** - status:FIXED - action:NO - two-transactions-deviate-from-the-one-transaction-rule -
  `AGENTS.md` states a write command opens one transaction. `start` and `complete` cannot,
  because the vendor handshake is asynchronous and `transact` refuses a thenable. - fix:
  Story 7 keeps the split and makes it safe with three guards, none of which is the gap
  itself: the synchronous vendor claim of Story 5 for `start`, the partial unique index
  behind it, and `UPDATE … WHERE state = 'pending'` for `complete`. Story 12 records the
  deviation beside the two deployment decisions. - why:An unrecorded deviation from a
  structural rule is how the rule dies. It should be a stated exception with its reason.
  Holding a transaction across the vendor call is not the alternative — it would take a
  `BEGIN IMMEDIATE` write lock for up to 30 seconds and stall every other write in the
  daemon.
- **B7** - status:FIXED - action:YES - concurrent-starts-race-two-live-flows - Two concurrent
  `start` calls both pass the pending-row pre-check, whose transaction commits before the
  service call, so both reach `login()`. The root cause is that mutual exclusion was asserted
  **after** the side effect it exists to prevent: the unique index guards the _row_, but the
  resource that actually collides is the _live flow_ — `anthropic` binds the fixed port 53692
  (`dist/auth/oauth/anthropic.js:17,131`), so the loser fails `EADDRINUSE` as `login-failed`
  instead of `login-in-progress`. A row cannot be the lock, because `method` and the device
  arm's `expires_at` are unknown until the vendor answers. - fix:Story 5 claims the vendor in
  a `Set` **synchronously, as the first statement of `startLogin`**, releases it on every
  throwing path and **not** on success, and drops it wherever the `#logins` entry is deleted.
  Story 7 keeps the insert catch as the backstop. - why:Node is single-threaded and the home
  lock guarantees one process, so a synchronous claim cannot interleave and the second caller
  is refused before touching the port. It costs about ten lines in a file Story 5 already
  writes, with no schema change, no reservation state and no crash-recovery sweep. Holding
  the claim past `startLogin`'s return is what closes the window between that return and the
  command's INSERT — a `finally` would reopen it. The index still covers the one case the
  claim cannot: a row left by a previous process.
- **B8** - status:FIXED - action:YES - completed-row-expiry-was-unspecified - The EPIC says
  the first request observing _an expired row_ tears it down, without narrowing that to
  `pending`. A `completed` row also carries `expires_at`. - fix:Story 7 checks expiry
  **before** state, so a `completed` row past its deadline refuses `login-expired` and is
  deleted. - why:Otherwise a completed login replays forever and holds a credential past its
  stated lifetime. If the human wants a completed row to outlive its expiry until
  registration, the EPIC must say so and `provider.register` must then enforce its own
  deadline.
- **B9** - status:FIXED - action:NO - the-store-does-not-serialize-modify - The library's
  `modify` contract asks for mutual exclusion per provider id and for the callback to see
  the current credential. The engine's store is built per probe from a snapshot and holds no
  lock, so two concurrent `provider.verify` calls on one oauth row can both refresh from the
  same token. The root cause is the adapter's **lifetime**, not a missing mutex: the store is
  built per probe (`src/services/provider-auth/pi-ai.ts:144`), so the two callers hold two
  different objects with no shared state to lock on, and a mutex inside a per-request object
  serializes nothing. EPIC 044 designed it as a read-only shim to satisfy a required
  `builtinModels` parameter; this epic gives that shim a write path. - fix:Story 6 states
  both departures and Story 12 records them. The real fix is one long-lived store backed by
  storage rather than a snapshot, with a per-provider promise chain and
  `SELECT → fn → UPDATE` in one transaction — deferred as scope. - why:Bounded, not benign.
  Under refresh-token rotation the second refresh usually fails and surfaces a spurious
  `authentication: "rejected"` on a healthy registration; where a grace window lets both
  succeed, the later write wins and one issued pair is orphaned. No row is corrupted — the
  write is a whole-payload replace in one transaction — and the daemon is single-host, so the
  racers are two requests in one process. **Do not cite the credential-snapshot-at-request-start
  rule as cover**: that rule governs the probe's read semantics and its reason is lock
  duration across a vendor round-trip, neither of which reaches a local `SELECT` in the write
  path.
- **S1** - status:FIXED - action:YES - kimi-coding-does-not-return-model-ids - The EPIC says
  "`github-copilot` and `kimi-coding` return the first". Only `github-copilot` sets
  `availableModelIds`; `grep` over the installed flows finds zero hits in `kimi-coding`,
  `xai`, `anthropic`, `openrouter`, `radius` and `openai-codex`. - fix:Stories 5 and 7
  implement the rule as written — the login's list when it carries one, the catalogue list
  otherwise — and assert both branches; the EPIC sentence should drop `kimi-coding`. -
  why:The behaviour is right either way, but a test written from the EPIC's claim would
  assert a list `kimi-coding` never returns.
- **S2** - status:FIXED - action:YES - register-needs-a-default-model-refusal - The EPIC
  gives `provider.register` a `defaultModel` on the oauth arm but names no refusal for a
  model absent from the login's list. - fix:Story 8 adds the
  `default-model-unknown` refusal, mapped onto the existing `invalid-request` code. -
  why:Without it the engine stores a default model the account cannot use, and the failure
  surfaces later as a confusing verify or run error.
- **S3** - status:FIXED - action:YES - register-oauth-arm-nesting-is-ambiguous - The EPIC
  writes the arm as `{ transport: "oauth", loginId, name, defaultModel }`, which reads as a
  flat body, but `name` is today a sibling of `payload` and `kind` is the discriminator. -
  fix:Story 10 nests `{ transport, loginId, defaultModel }` under `payload` and leaves
  `name` and `kind` where they are. - why:It keeps one request shape and one `kind`
  dispatch; a flat arm would need a third top-level union member and a second code path in
  the handler. Confirm the wire shape before the dashboard builds against it.
- **S4** - status:OPEN - action:YES - two-of-the-four-unpinned-vendors-are-reachable-after-all -
  The EPIC's hermetic list requires the option ids and prompt messages of "every admitted
  vendor" to be asserted against the installed library. My first reading waived four
  vendors; that was too strong. `kimi-coding` and `xai` fail only because their first act is
  an HTTP request, and a test can stub `globalThis.fetch` in a `t.before`/`t.after` pair —
  the same technique the exploration used to observe them. Only `anthropic` and `openrouter`
  are genuinely out of reach, because they bind a real loopback callback port before their
  first `notify`, and no `fetch` stub prevents a `net` listen. - fix:Story 4 keeps the three
  network-free pins and **adds** two `globalThis.fetch`-stubbed cases pinning the
  `device_code` notify of `kimi-coding` and `xai`, restoring the stub in `t.after`. Leave
  `anthropic` and `openrouter` unpinned and say why. - why:Two more vendors of real coverage
  for a well-understood stub; only the port-binding pair is a true waiver.
- **S5** - status:OPEN - action:YES - worktree-has-no-node-modules - `npm install` has not
  run in this worktree, so `npm run verify` cannot run and the library is not resolvable
  here. - fix:Run `npm install` before starting Story 1. - why:This is an operational
  preflight, **not** a planning defect — it is listed here only so the first story does not
  fail for a reason that has nothing to do with the plan.
