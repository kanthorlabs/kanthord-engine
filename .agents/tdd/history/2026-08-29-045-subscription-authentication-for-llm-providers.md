---
epic: .agents/plan/epics/045-subscription-authentication-for-llm-providers.md
opened: 2026-08-29
opener: test-engineer
base-ref: 6fe23085e8b70b410ab6cca9155012112de08d4d
---

# Implementation cycle — 045-subscription-authentication-for-llm-providers

Pulled from EPIC: `.agents/plan/epics/045-subscription-authentication-for-llm-providers.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/path.test.ts \
>   src/domain/provider-payload.test.ts \
>   src/services/storage/migration-0010-provider-login.test.ts \
>   src/services/provider-auth/pi-ai.test.ts \
>   src/commands/provider/start-provider-login.test.ts \
>   src/commands/provider/complete-provider-login.test.ts \
>   src/commands/provider/cancel-provider-login.test.ts \
>   src/commands/provider/register-provider.test.ts \
>   src/queries/provider/read-catalog.test.ts \
>   src/http/contract/credential.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/server/credential/start-provider-login.test.ts \
>   src/http/server/credential/complete-provider-login.test.ts \
>   src/http/server/credential/cancel-provider-login.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-045"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - No test reaches a real vendor. Every case injects a `pi-ai` `OAuthAuth` double, and the assertions
>   name the exact vendor id, the exact returned challenge and the exact code passed to the double.
> - Both path tuples are asserted legal by `isLegalPath`, and a tuple with a `parameter` after the
>   `login` subresource is asserted illegal. The two new segments are asserted singular.
> - The admitted set is asserted against the installed library, not against a literal list. The test
>   reads `auth.oauth` from `builtinProviders()`, intersects it with the catalogue, asserts the derived
>   set equals those six ids, and asserts that no flow module loads. The load assertion is made by
>   passing a `lazyOAuth`-shaped double whose `load` sets a flag and asserting the flag stays false —
>   a synchronous return proves only that no import was awaited, not that none was started.
> - `radius` is asserted absent from the catalogue and absent from the admitted set, and
>   `getBuiltinProviders()` is asserted not to carry it while `builtinProviders()` does. A library
>   change that catalogues `radius` therefore fails the suite rather than silently widening the set.
> - The pinned method is asserted by value for every vendor a hermetic test can observe, and both
>   device-code spellings and the browser option id are asserted as exact strings against the installed
>   library. Five vendors are observable: `openai-codex`, `radius` and `github-copilot` answer a prompt
>   before touching the network, and `kimi-coding` and `xai` are asserted to be promptless device-code
>   flows under a stubbed `globalThis.fetch`. `anthropic` and `openrouter` are **not** asserted: each
>   binds a real loopback callback port before its first event, no `fetch` stub prevents a socket
>   listen, and the flow modules carry no public export path. That gap is deliberate, and a test that
>   opened a port to close it would break the hermetic rule it serves.
> - A `select` whose options carry no recognized spelling refuses `login-method-unavailable`, and the
>   double records no further prompt.
> - A flow that asks a `text` prompt with no matching `answers` entry refuses `login-input-required`,
>   and `details.detail` holds the exact prompt message. The message string of `github-copilot`, the
>   one admitted vendor that asks a `text` prompt, is asserted against the installed library.
> - `provider.catalog` carries a non-null `oauth` member for exactly the derived six, and `null` for
>   every other provider. `openai-compatible` is asserted to carry `null`. The `label` of a vendor with
>   no `loginLabel` is asserted to equal its `name`, and the `label` of one with a `loginLabel` is
>   asserted to equal that.
> - An api-key registration with no `transport` field produces a stored payload whose **decrypted
>   plaintext** is byte-identical to the one it produces before this epic, and a `ProviderView`
>   deep-equal to the pre-epic one in every field except `projection.transport`, which is new and
>   carries `"api-key"`. The backward-compatibility case is asserted by deep-equal against that
>   expectation, not by "still works".
>
>   Two precisions this bullet needs. The projection gains `transport` by the decision above, so a
>   literal whole-`ProviderView` deep-equal against the pre-epic value cannot hold and is not the
>   oracle. And the comparison is on plaintext, never on ciphertext: AES-GCM takes a fresh
>   initialization vector per record (`docs/proposal/database/provider.md`), so two registrations of
>   one payload never produce equal `payload_ciphertext`.
>
> - `transport: "api-key"` and an absent `transport` produce deep-equal results.
> - A completed login stores the exact `availableModelIds` of the login result when it carries them,
>   and the exact catalogue model ids of the authenticated vendor otherwise. Both are asserted by value,
>   with zero outbound calls.
> - A `code` on the device arm refuses `code-not-accepted`. An absent `code` on a still-suspended
>   manual arm refuses `code-required`. An absent `code` on a manual arm whose double already resolved
>   through the callback succeeds and answers the models.
> - A `complete` on the device arm while the double still polls refuses `login-pending`, and the row
>   stays `pending`. The following `complete` after the double resolves succeeds and the row is
>   `completed`.
> - A successful `complete` leaves exactly one row, in state `completed`, holding a payload. A
>   successful `register` leaves zero rows. Each is asserted by a row count.
> - A second `complete` on a `completed` row answers a result deep-equal to the first, makes zero
>   outbound calls and leaves every column byte-identical. A third call answers the same again. A `code`
>   supplied on that replay changes nothing.
> - The device challenge carries `pollIntervalMs` equal to the event's `intervalSeconds` times one
>   thousand, asserted by value, and five thousand when the vendor omits it.
> - `provider.loginCancel` on a `pending` row aborts the double through its `AbortSignal`, answers
>   `204` and leaves zero rows. On a `completed` row it leaves zero rows and no provider row is written.
>   On an unknown `loginId` it answers `not-found`. A `start` for the same vendor immediately after a
>   cancel succeeds, which is the case `login-in-progress` otherwise refuses.
> - Replaying a `loginId` after a successful register answers `not-found`, and no second provider row
>   exists.
> - A second `start` for a vendor with a `pending` row refuses `login-in-progress`, and no second row
>   exists.
> - A `complete` on a `pending` row whose stored instance is not the running one refuses `login-lost`
>   and leaves zero rows. A `register` on a `completed` row whose stored instance is not the running one
>   succeeds.
> - The first `complete` after the manual arm's ten minutes refuses `login-expired`, aborts the double
>   through its `AbortSignal`, and leaves zero rows. The next call with the same `loginId` answers
>   `not-found`. Both boundaries are asserted with a mock clock at an exact millisecond.
> - The device arm's `expires_at` is asserted to equal the clock at the `device_code` event plus the
>   event's `expiresInSeconds`, not `created_at` plus it. A fixture whose first prompt consumes two
>   minutes proves the difference. An event with no `expiresInSeconds` falls back to ten minutes,
>   asserted by value.
> - A vendor with no `auth.oauth` answers `provider-not-oauth-capable` from `provider.loginStart`, with
>   zero outbound calls.
> - A refresh driven through the store re-encrypts the row, appends exactly one
>   `provider.credentialRefreshed` event, and leaves every other column unchanged. A failing refresh
>   leaves the ciphertext byte-identical and appends no event.
> - No response body, projection, event payload or error `detail` of any operation in this epic
>   contains `access`, `refresh`, `expires` or the PKCE verifier. The assertion searches each serialized
>   response for the fixture token values.
> - The stored `provider_login` payload of a `completed` row is ciphertext: the fixture token values do
>   not appear in the raw column bytes.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — path-grammar-login-segments · 01-path-grammar-login-segments

**Cycle.** RED for Task `01-path-grammar-login-segments` (`src/http/contract/path.test.ts`, `src/http/contract/registry.test.ts`).
**Test written.**

- file: `src/http/contract/path.test.ts` (edited) — suite: `src/http/contract/path.test` — methods: `pins the closed-array sizes`, `login is a subresource segment sorted between llm and node`, `complete is an action segment sorted between claim and delete`
- file: `src/http/contract/registry.test.ts` (edited) — suite: `src/http/contract/registry.test` — methods: `refuses a parameter after the login subresource`, `accepts the two login tuples`
- asserts: The closed sets expose sorted singular `login` and `complete` segments, render all three login paths, and accept or refuse the specified path tuples.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failures: `16 !== 17`; `login subresource segment is missing`; `complete action segment is missing`; `2 !== 1`; and `segment is invalid in its declared kind`.
  **Open to Software Engineer.**
- `src/http/contract/path.ts` — exported `subresourceSegments`, `actionSegments`, `SubresourceSegment`, `ActionSegment`, `sub`, and `action` admit the values exercised by these tests.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — path-grammar-login-segments · 01-path-grammar-login-segments

**Cycle.** GREEN+REFACTOR for `src/http/contract/path.test.ts` and `src/http/contract/registry.test.ts`.
**Files changed.**

- `src/http/contract/path.ts` (edited) — added sorted `login` and `complete` segment members.
- `docs/proposal/api/README.md` (edited) — documented both path grammar spellings.
  **Seam (GREEN).** The closed segment unions now admit the three login paths exercised by the failing tests.
  **Refactor.** No named refactor exists in the Story; formatted the amended proposal table.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the Story requires `login` between `llm` and `node`, and `complete` between `claim` and `delete`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — payload-oauth-variant · 02-payload-oauth-variant

**Cycle.** RED for Task `02-payload-oauth-variant` (`src/domain/provider-payload.test.ts`).
**Test written.**

- file: `src/domain/provider-payload.test.ts` (edited) — suite: `src/domain/provider-payload.test` — methods: `parses an oauth payload`, `keeps an unknown credential key through parse and serialization`, `refuses an oauth payload carrying an apiKey`, `refuses an oauth payload with no credential`, `refuses a transport outside the two llm arms`, `round trips the oauth payload byte-identically`, `an explicit api-key transport serializes to the same bytes as an absent one`, `an explicit api-key transport parses to the same payload as an absent one`, `projects the oauth payload with no credential`, `projects the api-key payload with an explicit transport`, `no credential field survives in any projection`, `llmApiKeyProjection and gitProjection each reject an unknown key`, `every projection satisfies the public response schema`
- asserts: The llm payload union accepts OAuth credentials, preserves unknown credential fields, keeps API-key bytes compatible, and exposes transport-safe projections without secrets.
  **RED proof.**
- command: `npm run typecheck`
- exit: non-zero — failure: `src/domain/provider-payload.test.ts(15,3): error TS2724: '"./provider-payload.ts"' has no exported member named 'llmApiKeyProjection'. Did you mean 'llmProjection'?`
- command: `npm test`
- exit: non-zero — failure: `SyntaxError: The requested module './provider-payload.ts' does not provide an export named 'llmApiKeyProjection'`
  **Open to Software Engineer.**
- `src/domain/provider-payload.ts` — export `llmApiKeyProjection` and the `llm` payload/projection surface consumed by this test: `LlmApiKeyPayload`, `LlmOauthPayload`, `LlmPayload`, `ProviderProjection`, `parsePayload`, `serializePayload`, `deserializePayload`, `projectPayload`, and `providerProjection`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — payload-oauth-variant · 02-payload-oauth-variant

**Cycle.** GREEN+REFACTOR for `src/domain/provider-payload.test.ts`.
**Files changed.**

- `src/domain/provider-payload.ts` (edited) — added OAuth credentials, LLM transport arms, projections and serialization branches.
- `src/commands/provider/register-provider.ts` (edited) — narrowed API-key validation to the API-key arm.
- `src/queries/provider/verify-provider.ts` (edited) — refused OAuth credentials with the existing temporary refusal.
  **Seam (GREEN).** The domain union parses OAuth credentials, preserves unknown credential keys, keeps API-key bytes unchanged and projects neither credential arm's secret.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 2 — `src/http/server/credential/list-provider.test.ts(25,5)` and `src/http/server/credential/set-default-provider.test.ts(21,3)` omit required `projection.transport`.
  **Assumptions.**
- VERIFIED: Story 2 requires `transport: "api-key"` on the API-key projection schema and requires the OAuth verification path to use `provider-not-verifiable` temporarily.
- OPEN: `src/http/server/credential/list-provider.test.ts` and `src/http/server/credential/set-default-provider.test.ts` need `transport: "api-key"` in their typed LLM projection fixtures; test files are the test-engineer's lane.

ATTEMPT-FAILED: 02-payload-oauth-variant — typecheck is blocked by two stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text

> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/http/server/credential/list-provider.test.ts(25,5): error TS2322: Type '{ provider: string; defaultModel: string; baseUrl: null; }' is not assignable to type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; } | { transport: "oauth"; provider: string; defaultModel: string; } | { transport: "http-basic" | "ssh"; forge: "github" | ... 2 more ... | null; username: string | null; } | null'.
  Property 'transport' is missing in type '{ provider: string; defaultModel: string; baseUrl: null; }' but required in type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; }'.
src/http/server/credential/set-default-provider.test.ts(21,3): error TS2322: Type '{ provider: string; defaultModel: string; baseUrl: null; }' is not assignable to type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; } | { transport: "oauth"; provider: string; defaultModel: string; } | { transport: "http-basic" | "ssh"; forge: "github" | ... 2 more ... | null; username: string | null; } | null'.
  Property 'transport' is missing in type '{ provider: string; defaultModel: string; baseUrl: null; }' but required in type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; }'.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software engineer must fix the build, re-run with log output, verify, resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — payload-oauth-variant · build re-verification

**Cycle.** Re-verification for Task `02-payload-oauth-variant`.
**Files changed.**

- none — no production change can resolve errors in locked test files.
  **Seam (GREEN).** The required API-key transport remains explicit in `ProviderProjection`.
  **Refactor.** deferred: the test-engineer must update the two stale projection fixtures.
  **Build check.**
- typecheck: exit 2 — `list-provider.test.ts:25` and `set-default-provider.test.ts:21` omit required `projection.transport`.
  **Assumptions.**
- OPEN: `src/http/server/credential/list-provider.test.ts` and `src/http/server/credential/set-default-provider.test.ts` — add `transport: "api-key"` to each LLM projection fixture; these test files are the test-engineer's lane.

ATTEMPT-FAILED: 02-payload-oauth-variant — typecheck remains blocked by two stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/http/server/credential/list-provider.test.ts(25,5): error TS2322: Type '{ provider: string; defaultModel: string; baseUrl: null; }' is not assignable to type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; } | { transport: "oauth"; provider: string; defaultModel: string; } | { transport: "http-basic" | "ssh"; forge: "github" | ... 2 more ... | null; username: string | null; } | null'.
  Property 'transport' is missing in type '{ provider: string; defaultModel: string; baseUrl: null; }' but required in type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; }'.
src/http/server/credential/set-default-provider.test.ts(21,3): error TS2322: Type '{ provider: string; defaultModel: string; baseUrl: null; }' is not assignable to type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; } | { transport: "oauth"; provider: string; defaultModel: string; } | { transport: "http-basic" | "ssh"; forge: "github" | ... 2 more ... | null; username: string | null; } | null'.
  Property 'transport' is missing in type '{ provider: string; defaultModel: string; baseUrl: null; }' but required in type '{ transport: "api-key"; provider: string; defaultModel: string; baseUrl: string | null; }'.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software engineer must fix the build, re-run with log output, verify, resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — payload-oauth-variant · 02-payload-oauth-variant

**Cycle.** Re-verification for Task `02-payload-oauth-variant`.
**Files changed.**

- none — no production change can resolve errors in locked test files.
  **Seam (GREEN).** The required API-key transport remains explicit in `ProviderProjection`.
  **Refactor.** deferred: the test-engineer must update the two stale projection fixtures.
  **Build check.**
- typecheck: exit 2 — `src/http/server/credential/list-provider.test.ts:25` and `src/http/server/credential/set-default-provider.test.ts:21` omit required `projection.transport`; `tsc` reports `TS2322` for both fixtures.
  **Assumptions.**
- OPEN: `src/http/server/credential/list-provider.test.ts` — add `transport: "api-key"` to the LLM projection fixture.
- OPEN: `src/http/server/credential/set-default-provider.test.ts` — add `transport: "api-key"` to the LLM projection fixture.

ATTEMPT-FAILED: 02-payload-oauth-variant — typecheck remains blocked by two stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER
DEBATE_GUIDELINE: 02-payload-oauth-variant — update the two stale API-key projection fixtures in the test-engineer lane
GUIDELINE: At src/http/server/credential/list-provider.test.ts:25, add transport: "api-key" before provider in the LLM projection fixture.
GUIDELINE: At src/http/server/credential/set-default-provider.test.ts:21, add transport: "api-key" before provider in the LLM projection fixture.
GUIDELINE: Run npm run verify:handoff and require VERIFY: PASS — npm run typecheck is clean.

## TEST-ENGINEER — payload-oauth-variant · 02-payload-oauth-variant re-verification

**Cycle.** Confirm GREEN for Task `02-payload-oauth-variant` after the required fixture updates.
**Test written.**

- file: `src/http/server/credential/list-provider.test.ts` (edited) — suite: `src/http/server/credential/list-provider.test` — methods: existing provider list response fixture
- file: `src/http/server/credential/set-default-provider.test.ts` (edited) — suite: `src/http/server/credential/set-default-provider.test` — methods: existing set-default response fixture
- asserts: Existing API-key projection fixtures carry the explicit `transport: "api-key"` discriminator.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ refuses each missing key with payload-invalid naming the key`
- command: `node --test src/domain/provider-payload.test.ts`
- exit: non-zero — failures: `✖ refuses each missing key with payload-invalid naming the key`; `✖ refuses an llm payload with an extra key`; `✖ llmPayload.safeParse refuses extra key with exact detail format`
  **Handoff re-verification.**
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Open to Software Engineer.**
- `src/domain/provider-payload.ts` — exported `llmPayload` and `parsePayload(kind, input)` preserve the existing API-key validation refusal details and issue shape while supporting the OAuth arm.

ATTEMPT-FAILED: 02-payload-oauth-variant — focused payload tests remain red on three existing API-key validation assertions

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — payload-oauth-variant · 02-payload-oauth-variant

**Cycle.** GREEN+REFACTOR for `src/domain/provider-payload.test.ts`.
**Files changed.**

- `src/domain/provider-payload.ts` (edited) — discriminated LLM payload union.
  **Seam (GREEN).** The discriminator selects the API-key arm for absent transport and preserves its validation issues.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `llmPayload` selects the OAuth arm by `transport: "oauth"` and the API-key arm by absent or `"api-key"` transport.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — provider-login-migration · 03-provider-login-migration

**Cycle.** Confirmed GREEN for Task `02-payload-oauth-variant`; RED for Task `03-provider-login-migration` (`src/services/storage/migration-0010-provider-login.test.ts`, `src/services/storage/schema-parity.test.ts`, `src/domain/identity.test.ts`).
**Prior GREEN.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `node --test src/domain/provider-payload.test.ts` — exit 0 — 51 tests passed.
  **Test written.**
- file: `src/services/storage/migration-0010-provider-login.test.ts` (new) — suite: `src/services/storage/migration-0010-provider-login.test` — methods: `migration0010ProviderLogin carries version 10, its name, and no rebuild`, `migrations holds exactly ten migrations with migration0010ProviderLogin last`, `a database at version 9 migrates to 10 and gains provider_login`, `the migrated provider_login table and index equal the proposal fence`, `refuses a second pending row for the same vendor`, `refuses a pending row carrying ciphertext`, `refuses a completed row with no ciphertext`, `refuses a method or state outside its closed set`, `re-applying the full chain to an already-migrated database is a no-op`
- file: `src/services/storage/schema-parity.test.ts` (edited) — suite: `src/services/storage/schema-parity.test` — methods: `provider_login.method CHECK agrees with the domain providerLoginMethods`, `provider_login.state CHECK agrees with the domain providerLoginStates`
- file: `src/domain/identity.test.ts` (edited) — suite: `src/domain/identity.test` — methods: `parseIdentity round-trips the provider login prefix`, updated count and uniqueness assertions
- file: `src/domain/rows.test.ts` (edited) — suite: `src/domain/rows.test` — methods: updated table count and sorted table-name assertions
- files: `src/services/storage/migration-0001-core-entities.test.ts`, `src/services/storage/migration-0002-graph-and-plan.test.ts`, `src/services/storage/migration-0003-execution-and-journal.test.ts`, `src/services/storage/migration-0004-event-indexes.test.ts`, `src/services/storage/migration-0006-revision-origin.test.ts`, `src/services/storage/migration-0008-graph-indexes.test.ts`, `src/services/storage/migration-0009-one-branch.test.ts` (edited) — existing migration-chain, table-inventory and index-inventory expectations now include migration 0010
- asserts: Migration 0010 creates the exact provider-login table and partial index, enforces its closed states and payload invariants, preserves the ten-migration chain, and exposes the `login_` identity and sorted row inventory.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/storage/migration-0010-provider-login.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/storage/migration-0010-provider-login.test.ts`
- command: `node --test src/services/storage/migration-0010-provider-login.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/storage/migration-0010-provider-login.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/storage/migration-0010-provider-login.test.ts`
- stub probe: `src/services/storage/migration-0010-provider-login.ts` — clean
- stub probe: `src/domain/provider-login.ts` — clean
  **Open to Software Engineer.**
- `src/services/storage/migration-0010-provider-login.ts` — export `migration0010ProviderLogin: Migration` with version/name and the provider-login table and index contract asserted by the tests.
- `src/services/storage/migrations.ts` — export `migrations` with `migration0010ProviderLogin` as the tenth entry.
- `src/domain/provider-login.ts` — export `providerLoginMethods`, `ProviderLoginMethod`, `providerLoginStates`, `ProviderLoginState`, `providerLoginRow`, and `ProviderLoginRow`.
- `src/domain/identity.ts` — admit `providerLogin` with the `login` prefix.
- `src/domain/rows.ts` — expose `provider_login` through `providerLoginRow` in sorted order.
- `docs/proposal/database/provider_login.md` — provide the provider-login SQL fence and required table description.
- `docs/proposal/database/README.md` — add the provider-login table index row.
- `docs/proposal/phase-1/domain.md` — include `provider_login` in the documented table inventory.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — provider-login-migration · 03-provider-login-migration

**Cycle.** GREEN+REFACTOR for `src/services/storage/migration-0010-provider-login.test.ts`, `src/services/storage/schema-parity.test.ts`, and `src/domain/identity.test.ts`.
**Files changed.**

- `src/services/storage/migration-0010-provider-login.ts` (new) — migration 0010 DDL and pending-login index.
- `src/domain/provider-login.ts` (new) — provider-login methods, states and row schema.
- `src/services/storage/migrations.ts` (edited) — registered migration 0010 last.
- `src/domain/identity.ts` (edited) — added the `providerLogin` kind and `login` prefix.
- `src/domain/rows.ts` (edited) — registered `provider_login` in sorted order.
- `docs/proposal/database/provider_login.md` (new) — recorded the table and index fence.
- `docs/proposal/database/README.md` (edited) — added the table index row.
- `docs/proposal/phase-1/domain.md` (edited) — added the table inventory entry.
  **Seam (GREEN).** Migration, domain row, identity, registry and proposal schemas now expose the pending-login table asserted by the tests.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The migration DDL and provider-login row schema match the Story 3 prescribed shapes.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — oauth-vendor-set-and-method-rule · 04-oauth-vendor-set-and-method-rule

**Cycle.** RED for Task `04-oauth-vendor-set-and-method-rule` (`src/services/provider-auth/pi-ai.test.ts`).
**Test written.**

- file: `src/services/provider-auth/pi-ai.test.ts` (edited) — suite: `src/services/provider-auth/pi-ai.test` — methods: `derives the admitted set from the library, not from a list`, `excludes radius because the catalogue does not carry it`, `reads the eager oauth properties without loading a flow module`, `labels each vendor with loginLabel when it has one and name otherwise`, `excludes a provider with no oauth`, `prefers the underscore device spelling`, `prefers the hyphen device spelling`, `falls back to the browser option`, `refuses an option set with no recognized spelling`, `prefers device over browser regardless of order`, `pins the openai-codex select option ids against the installed library`, `pins the radius select option ids against the installed library`, `pins the github-copilot enterprise prompt message against the installed library`, `pins kimi-coding as a promptless device-code flow`, `pins xai as a promptless device-code flow`
- file: `test/helpers/provider-auth.ts` (new) — helper: `createFakeProviderAuth`
- file: `src/queries/provider/verify-provider.test.ts` (edited) and `src/http/server/credential/verify-provider.test.ts` (edited) — existing provider-auth doubles now use the shared fake
- asserts: The service derives six catalogued OAuth vendors, pins eager metadata and installed prompts, chooses device methods before browser, refuses unknown methods, and performs no flow-network work for promptless pins.
  **RED proof.**
- command: `npm test -- src/services/provider-auth/pi-ai.test.ts`
- exit: non-zero — failure: `SyntaxError: The requested module './index.ts' does not provide an export named 'LoginError'`
  **Open to Software Engineer.**
- `src/services/provider-auth/index.ts` — export `deviceCodeOptionIds`, `browserOptionId`, `LoginMethod`, `OauthVendor`, `LoginRefusal`, `LoginError`, and `ProviderAuth.oauthVendors(): readonly OauthVendor[]`.
- `src/services/provider-auth/pi-ai.ts` — export `chooseOptionId(vendorId: string, optionIds: readonly string[]): string` and provide `PiAiProviderAuth.oauthVendors(): readonly OauthVendor[]`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — oauth-vendor-set-and-method-rule · 04-oauth-vendor-set-and-method-rule

**Cycle.** GREEN+REFACTOR for `src/services/provider-auth/pi-ai.test.ts`.
**Files changed.**

- `src/services/provider-auth/index.ts` (edited) — OAuth vendor types, login refusal and method constants.
- `src/services/provider-auth/pi-ai.ts` (edited) — derived OAuth vendor enumeration and method selection.
  **Seam (GREEN).** The auth service derives catalogued OAuth metadata and chooses a recognized device or browser option.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: `getBuiltinProviders()` supplies the catalogue intersection and eager `OAuthAuth` fields require no flow loading.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — suspended-login-adapter · 05-suspended-login-adapter

**Cycle.** RED for Task `05-suspended-login-adapter` (`src/services/provider-auth/pi-ai.test.ts`).
**Test written.**

- file: `src/services/provider-auth/pi-ai.test.ts` (edited) — suite: `src/services/provider-auth/pi-ai.test` — methods: `refuses a vendor with no oauth flow and makes no call`, `answers a select with the device-code option`, `refuses a select with no recognized option and prompts no further`, `answers a text prompt from answers`, `refuses a text prompt with no matching answer and carries the message`, `returns the device challenge with the event interval in milliseconds`, `falls back to five seconds and ten minutes when the event omits them`, `times the device expiry from the event, not from the start`, `returns the manual challenge from the auth_url event`, `ignores progress and info events`, `supplies the pasted code to the suspended manual prompt`, `completes a manual login the callback already resolved, with no code`, `refuses an absent code on a still-suspended manual arm`, `answers pending while the device flow still polls`, `answers lost for an unknown loginId`, `reads availableModelIds when the credential carries them`, `answers null model ids when the key is absent or malformed`, `aborts the live flow through its signal and forgets it`, `propagates a login failure as login-failed`, `does not leak the token into the LoginError message or detail`, `answers a prompt issued synchronously before login returns`, `aborts the flow when the vendor answers nothing before the start deadline`, `aborts the flow when startLogin fails before a challenge`, `refuses a second concurrent start for one vendor before calling the flow`, `admits a concurrent start for a different vendor`, `holds the claim after startLogin returns`, `releases the claim when the flow fails`, `releases the claim on abort`, `releases the claim when the login completes`, `releases the claim for a vendor with no oauth flow`
- file: `test/helpers/provider-auth.ts` (edited) — helper: `createFakeProviderAuth`
- asserts: The adapter returns exact manual and device challenges, answers prompts, completes or reports pending and lost flows, aborts and maps failures, preserves model ids, and enforces vendor claims.
  **RED proof.**
- command: `npm test -- src/services/provider-auth/pi-ai.test.ts`
- exit: non-zero — failure: `TypeError: auth.startLogin is not a function`
  **Open to Software Engineer.**
- `src/services/provider-auth/index.ts` — exported login constants and types, widened `LoginRefusal`, and `ProviderAuth.startLogin(input: StartLoginInput): Promise<LoginChallenge>`, `completeLogin(input: CompleteLoginInput): Promise<CompleteLoginOutcome>`, `abortLogin(loginId: string): void`.
- `src/services/provider-auth/pi-ai.ts` — exported `PiAiProviderAuth` constructor dependency seam with `resolveOauth` and `clock`, plus its `startLogin`, `completeLogin`, and `abortLogin` methods.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — suspended-login-adapter · 05-suspended-login-adapter

**Cycle.** GREEN+REFACTOR for `src/services/provider-auth/pi-ai.test.ts`.
**Files changed.**

- `src/services/provider-auth/index.ts` (edited) — login challenge, input, outcome and service types.
- `src/services/provider-auth/pi-ai.ts` (edited) — suspended OAuth login lifecycle and cancellation.
  **Seam (GREEN).** The adapter drives injected OAuth interactions, stores live flows, returns challenges, and completes or aborts logins.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `Clock` is injected through the service interface and device expiry uses its event-time reading.
- VERIFIED: Non-`LoginError` vendor failures map to a token-safe `login-failed` error.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — credential-store-write-path · 06-credential-store-write-path

**Cycle.** RED for Task `06-credential-store-write-path` (`src/services/provider-auth/credential-writer.test.ts`, `src/services/provider-auth/pi-ai.test.ts`, `src/queries/provider/verify-provider.test.ts`, `src/http/contract/event-payload.test.ts`).
**Test written.**

- file: `src/services/provider-auth/credential-writer.test.ts` (new) — suite: `src/services/provider-auth/credential-writer` — methods: `re-encrypts the row and appends exactly one provider.credentialRefreshed event`, `changes no other column`, `writes new ciphertext bytes`, `a failing write leaves the ciphertext byte-identical and appends no event`, `is a no-op for a provider row that no longer exists`, `is a no-op for an api-key payload`
- file: `src/services/provider-auth/pi-ai.test.ts` (edited) — suite: `src/services/provider-auth/pi-ai` — methods: `serves the oauth credential to the library store`, `persists a refreshed oauth credential through the writer`, `writes nothing when the modify callback answers undefined`, `writes nothing when the modify callback rejects`, `writes nothing for an api-key credential`, `admits an oauth-only vendor`, `still refuses an api-key row for a vendor with no api-key auth`
- file: `src/queries/provider/verify-provider.test.ts` (edited) — suite: `src/queries/provider/verify-provider` — methods: `returns the complete verdict and passes the stored row and signal`, `verifies an oauth registration`
- file: `src/http/contract/event-payload.test.ts` (edited) — suite: `src/http/contract/event-payload` — method: `provider.credentialRefreshed payload rejects an extra key`
- file: `src/http/server/credential/verify-provider.test.ts` (edited) — existing probe fixture narrows the transport union before reading the API key
- asserts: OAuth refreshes preserve the credential and provider metadata, persist one daemon event, roll back on failure, expose OAuth through verification, and never write API-key refreshes.
  **RED proof.**
- command: `npm test -- src/services/provider-auth/credential-writer.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/provider-auth/credential-writer.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/services/provider-auth/credential-writer.test.ts`
- command: `npm test -- src/services/provider-auth/pi-ai.test.ts`
- exit: non-zero — failure: `Error: vendor openai-codex has no api-key auth in the pi-ai catalog`
- stub probe: `src/services/provider-auth/credential-writer.ts` — no test-body errors; the expected `CredentialWriter` export remains missing from `src/services/provider-auth/index.ts`.
  **Open to Software Engineer.**
- `src/services/provider-auth/index.ts` — export `ProviderAuthRowBase`, the transport-union `ProviderAuthRow` with `providerId`, `CredentialWriter`, and `CredentialWriter.write(providerId: string, credential: Readonly<Record<string, unknown>>): void`.
- `src/services/provider-auth/credential-writer.ts` — export `SqliteCredentialWriterDependencies` and `SqliteCredentialWriter` with `write(providerId: string, credential: Readonly<Record<string, unknown>>): void`.
- `src/services/provider-auth/pi-ai.ts` — accept `credentialWriter?: CredentialWriter` and expose the transport-specific credential store behavior through `PiAiProviderAuth`.
- `src/queries/provider/verify-provider.ts` — pass `providerId`, transport, and the matching credential fields to `ProviderAuth` for API-key and OAuth registrations.
- `src/domain/event-type.ts` — include the `"provider.credentialRefreshed"` event type.
- `src/http/contract/event-payload.ts` — expose `eventPayloads["provider.credentialRefreshed"]` for the exact payload tested.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — credential-store-write-path · 06-credential-store-write-path

**Cycle.** GREEN+REFACTOR for `src/services/provider-auth/credential-writer.test.ts` and related Story 6 tests.
**Files changed.**

- `src/services/provider-auth/index.ts` (edited) — transport-union auth rows and credential writer port.
- `src/services/provider-auth/credential-writer.ts` (new) — transactional OAuth re-encryption and refresh event.
- `src/services/provider-auth/pi-ai.ts` (edited) — transport-specific store reads, writes and OAuth probe guard.
- `src/queries/provider/verify-provider.ts` (edited) — OAuth and API-key auth-row construction.
- `src/domain/event-type.ts` (edited) — `provider.credentialRefreshed` event type.
- `src/http/contract/event-payload.ts` (edited) — refresh event payload schema.
- `src/main.ts` (edited) — SQLite credential writer composition and injection.
  **Seam (GREEN).** The store serves OAuth credentials, persists refreshes through one transaction, and verifies OAuth-only registrations.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
- runtime smoke: `npm start -- --help` exit 0
  **Assumptions.**
- VERIFIED: Refresh events use fixed `daemon` attribution and contain no credential fields.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — login-commands · 07-login-commands

**Cycle.** RED for Task `07-login-commands` (`src/commands/provider/start-provider-login.test.ts`, `src/commands/provider/complete-provider-login.test.ts`, `src/commands/provider/cancel-provider-login.test.ts`).
**Test written.**

- file: `src/commands/provider/start-provider-login.test.ts` (new) — suite: `src/commands/provider/start-provider-login.test` — methods: `refuses a vendor with no oauth flow and calls the service no further`, `inserts one pending row and answers the device challenge`, `answers the manual challenge and times its expiry from created_at`, `takes the device expiry from the challenge, not from created_at`, `refuses a second start for the same vendor with login-in-progress`, `allows a start for a different vendor`, `refuses login-expired on an expired pending row, deletes it, and aborts`, `maps login-input-required with the exact prompt message in detail`, `maps login-method-unavailable and writes no row`, `aborts and refuses login-in-progress when the insert loses the unique index`, `stores the running instance id`, `never stores or returns a token`, `the expired teardown survives the refusal`, `maps only a unique-constraint failure to login-in-progress`
- file: `src/commands/provider/complete-provider-login.test.ts` (new) — suite: `src/commands/provider/complete-provider-login.test` — methods: `answers not-found for an unknown loginId`, `completes a pending device login and stores the credential`, `refuses login-pending while the flow still polls and leaves the row pending`, `refuses code-not-accepted for a code on the device arm`, `refuses code-required for an absent code on a suspended manual arm`, `completes a manual login the callback already resolved, with no code`, `passes the exact pasted code to the service`, `prefers the model ids the login returned`, `falls back to the catalogue model ids`, `replays a completed login byte-identically`, `ignores a code supplied on a replay`, `refuses login-expired on the first call after the deadline and not-found after`, `refuses login-lost when the stored instance is not the running one`, `refuses login-lost when the service has forgotten the flow`, `a successful complete leaves exactly one row in state completed`, `the expired teardown survives the refusal`, `expires a completed row on the same rule`
- file: `src/commands/provider/cancel-provider-login.test.ts` (new) — suite: `src/commands/provider/cancel-provider-login.test` — methods: `cancels a pending login, aborts the flow and leaves zero rows`, `cancels a completed login and writes no provider row`, `answers not-found for an unknown loginId`, `a start for the same vendor immediately after a cancel succeeds`, `is safe when the service has no live flow`
- asserts: The three commands persist and consume login state, return exact challenges and model lists, enforce arm and instance rules, preserve replay bytes, tear down after committed refusals, release vendor uniqueness, and keep credentials out of responses and rows.
  **RED proof.**
- command: `npm test -- src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts`
- exit: non-zero — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/commands/provider/start-provider-login.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/commands/provider/cancel-provider-login.test.ts`
- stub probe: `src/commands/provider/start-provider-login.ts` — clean
- stub probe: `src/commands/provider/complete-provider-login.ts` — clean
- stub probe: `src/commands/provider/cancel-provider-login.ts` — clean
  **Open to Software Engineer.**
- `src/commands/provider/start-provider-login.ts` — export `StartProviderLoginDependencies`, `StartProviderLoginInput`, `StartProviderLoginRefusal`, `StartProviderLoginError`, `StartProviderLoginResult`, `MANUAL_LOGIN_LIFETIME_MS`, `isPendingLoginConflict(error: unknown): boolean`, and `startProviderLogin(dependencies, input): Promise<StartProviderLoginResult>`.
- `src/commands/provider/complete-provider-login.ts` — export `CompleteProviderLoginDependencies`, `CompleteProviderLoginInput`, `CompleteProviderLoginRefusal`, `CompleteProviderLoginError`, `CompleteProviderLoginResult`, and `completeProviderLogin(dependencies, input): Promise<CompleteProviderLoginResult>`.
- `src/commands/provider/cancel-provider-login.ts` — export `CancelProviderLoginDependencies`, `CancelProviderLoginInput`, `CancelProviderLoginRefusal`, `CancelProviderLoginError`, and `cancelProviderLogin(dependencies, input): Promise<void>`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — login-commands · 07-login-commands

**Cycle.** GREEN+REFACTOR for `src/commands/provider/start-provider-login.test.ts`, `src/commands/provider/complete-provider-login.test.ts` and `src/commands/provider/cancel-provider-login.test.ts`.
**Files changed.**

- `src/commands/provider/start-provider-login.ts` (new) — persisted login start, expiry handling and conflict mapping.
- `src/commands/provider/complete-provider-login.ts` (new) — login completion, encrypted payload persistence and replay.
- `src/commands/provider/cancel-provider-login.ts` (new) — committed login deletion and flow abort.
  **Seam (GREEN).** The three commands use the provider-auth port, synchronous storage transactions and injected clock, ids, crypto, catalogue and instance dependencies.
  **Refactor.** Applied the required committed teardown markers and guarded completion writes with the pending state.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: Expired and lost rows delete before `abortLogin`; completed rows replay encrypted model data without a service call.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — register-oauth-arm · 08-register-oauth-arm

**Cycle.** Confirmed GREEN for Task `07-login-commands`; RED for Task `08-register-oauth-arm` (`src/commands/provider/register-provider.test.ts`).
**Prior GREEN.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `npm test -- src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts` — exit 0 — `ℹ pass 36`.
  **Test written.**
- file: `src/commands/provider/register-provider.test.ts` (edited) — suite: `src/commands/provider/register-provider.test` — methods: `registers from a completed login and consumes the row`, `stores the credential encrypted and nowhere in plaintext`, `refuses login-not-found for an unknown loginId and writes nothing`, `refuses login-not-completed for a pending login and leaves the login row`, `refuses default-model-unknown when the model is not in the stored list`, `rolls the delete back when the insert fails`, `registers on a completed login whose stored instance is not the running one`, `replaying a consumed loginId refuses login-not-found and writes no second row`, `stamps the first llm registration by the oauth arm as the default`, `appends no new event type`, `an absent transport and an explicit api-key transport produce deep-equal results`; updated existing API-key projection expectations.
- asserts: OAuth registration consumes completed logins, preserves encrypted credentials, enforces refusals and rollback, stamps defaults and events, and keeps API-key storage compatible.
  **RED proof.**
- command: `npm test -- src/commands/provider/register-provider.test.ts`
- exit: non-zero — failure: `SyntaxError: The requested module '../../domain/provider-payload.ts' does not provide an export named 'llmOauthRegisterPayload'`
  **Open to Software Engineer.**
- `src/domain/provider-payload.ts` — export `llmOauthRegisterPayload` for `{ transport: "oauth", loginId, defaultModel }` and its inferred request type.
- `src/commands/provider/register-provider.ts` — extend `RegisterProviderRefusal` with `login-not-found`, `login-not-completed` and `default-model-unknown`; preserve `registerProvider(dependencies, input): ProviderView` for the OAuth request arm and its completed-login registration behavior.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — register-oauth-arm · 08-register-oauth-arm

**Cycle.** GREEN+REFACTOR for `src/commands/provider/register-provider.test.ts`.
**Files changed.**

- `src/domain/provider-payload.ts` (edited) — added the strict OAuth registration request schema.
- `src/commands/provider/register-provider.ts` (edited) — consumed completed login rows in the OAuth registration arm.
  **Seam (GREEN).** OAuth registration decrypts and validates the completed login inside the provider transaction, then deletes the login after insertion.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: API-key registration retains its canonical plaintext and OAuth registration projects no credential fields.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — register-oauth-arm · 08-register-oauth-arm re-verification

**Cycle.** Confirm GREEN for Task `08-register-oauth-arm`; confirmation is blocked by a test fixture identity.
**Handoff re-verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Confirm proof.**
- command: `npm test -- src/commands/provider/register-provider.test.ts`
- exit: non-zero — failure: `Error: the payload does not match the schema of kind llm` (`src/commands/provider/register-provider.ts:95`)
  **Finding.**
- `OAUTH_INPUT.loginId` is `login_01HZY8QF3M4N5P6R7S8T0W23`; its ULID has 24 characters, so the registration schema rejects the test input before the OAuth registration behavior runs.

ATTEMPT-FAILED: 08-register-oauth-arm — confirmation remains red because the OAuth registration fixture uses an invalid provider-login identity

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — register-oauth-arm · 08-register-oauth-arm

**Cycle.** Re-verification for Task `08-register-oauth-arm`.
**Files changed.**

- none — production behavior already matches the Story.
  **Seam (GREEN).** No production change can make the invalid OAuth login identity pass the required domain schema.
  **Refactor.** deferred: the test-engineer must correct the invalid fixture.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `identity("providerLogin")` requires a prefixed ULID with 26 ULID characters.
- OPEN: `src/commands/provider/register-provider.test.ts` — replace its 24-character `LOGIN_ULID` with a valid 26-character ULID; the test must reach OAuth registration behavior.

ATTEMPT-FAILED: 08-register-oauth-arm — confirmation remains red because the OAuth registration fixture uses an invalid provider-login identity

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — catalog-oauth-capability · 09-catalog-oauth-capability

**Cycle.** Confirmed GREEN for Task `08-register-oauth-arm`; RED for Task `09-catalog-oauth-capability` (`src/services/model-catalog/pi-ai.test.ts`, `src/queries/provider/read-catalog.test.ts`).
**Prior GREEN.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `npm test -- src/commands/provider/register-provider.test.ts` — exit 0 — `ℹ pass 29`.
  **Test written.**
- file: `src/commands/provider/register-provider.test.ts` (edited) — suite: `src/commands/provider/register-provider.test` — methods: existing OAuth registration tests with a valid provider-login ULID fixture
- file: `test/helpers/model-catalog.ts` (edited) — helper: `defaultCatalogProviders` — members: OAuth label for `anthropic`, null OAuth members for `openai` and `openai-compatible`
- file: `src/services/model-catalog/pi-ai.test.ts` (edited) — suite: `src/services/model-catalog/pi-ai` — methods: `carries a non-null oauth member for every catalogued oauth vendor`, `radius is absent from the catalogue`, `carries a null oauth member for every other provider`, `labels a vendor with no loginLabel by its oauth name`, `labels a vendor with a loginLabel by that label`, `reports only the label on the oauth member`, `carries only the closed provider fields`
- file: `src/queries/provider/read-catalog.test.ts` (edited) — suite: `src/queries/provider/read-catalog` — method: `passes the oauth member through unchanged`
- asserts: The catalog reports the six derived OAuth vendors, excludes `radius`, preserves exact labels, uses null elsewhere, and passes the member through unchanged.
  **RED proof.**
- command: `npm test -- src/services/model-catalog/pi-ai.test.ts src/queries/provider/read-catalog.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`
  **Open to Software Engineer.**
- `src/services/model-catalog/index.ts` — exported `CatalogOauth` and `CatalogProvider` expose `oauth: CatalogOauth | null`; `ModelCatalog.providers()` returns that member.
- `src/services/model-catalog/pi-ai.ts` — exported `PiAiModelCatalog` exposes the exact OAuth labels and null members asserted by the catalog tests.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — catalog-oauth-capability · 09-catalog-oauth-capability

**Cycle.** GREEN+REFACTOR for `src/services/model-catalog/pi-ai.test.ts` and `src/queries/provider/read-catalog.test.ts`.
**Files changed.**

- `src/services/model-catalog/index.ts` (edited) — added `CatalogOauth` and the required `oauth` member.
- `src/services/model-catalog/pi-ai.ts` (edited) — projected eager OAuth labels and the `openai-compatible` null member.
  **Seam (GREEN).** The catalogue reads OAuth metadata from its existing provider map and passes the member through unchanged.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 2 — three test fixtures require updates after the required `CatalogProvider` widening.
  - `src/commands/provider/complete-provider-login.test.ts:112` omits `oauth`.
  - `src/commands/provider/register-provider.test.ts:290` omits `oauth`.
  - `src/services/model-catalog/pi-ai.test.ts:66` compares a narrowed provider-id union with `"radius"`.
    **Assumptions.**
- VERIFIED: `src/queries/provider/read-catalog.ts` remains unchanged and returns `catalog.providers()` directly.
- OPEN: The test-engineer must update the two catalog fixtures with `oauth: null` and preserve the runtime radius assertion without the narrowed-union diagnostic.

ATTEMPT-FAILED: 09-catalog-oauth-capability — typecheck is blocked by three stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/commands/provider/complete-provider-login.test.ts(112,7): error TS2741: Property 'oauth' is missing in type '{ id: string; name: string; baseUrl: null; requiresBaseUrl: false; models: Readonly<{ id: string; name: string; api: string; provider: string; baseUrl: string; reasoning: boolean; input: readonly string[]; cost: CatalogModelCost; contextWindow: number; maxTokens: number; }>[]; }' but required in type 'Readonly<{ id: string; name: string; baseUrl: string | null; requiresBaseUrl: boolean; oauth: Readonly<{ label: string; }> | null; models: readonly Readonly<{ id: string; name: string; api: string; provider: string; ... 5 more ...; maxTokens: number; }>[]; }>'.
src/commands/provider/register-provider.test.ts(290,9): error TS2741: Property 'oauth' is missing in type '{ id: string; name: string; baseUrl: null; requiresBaseUrl: false; models: Readonly<{ id: string; name: string; api: string; provider: string; baseUrl: string; reasoning: boolean; input: readonly string[]; cost: CatalogModelCost; contextWindow: number; maxTokens: number; }>[]; }' but required in type 'Readonly<{ id: string; name: string; baseUrl: string | null; requiresBaseUrl: boolean; oauth: Readonly<{ label: string; }> | null; models: readonly Readonly<{ id: string; name: string; api: string; provider: string; ... 5 more ...; maxTokens: number; }>[]; }>'.
src/services/model-catalog/pi-ai.test.ts(66,50): error TS2367: This comparison appears to be unintentional because the types '"openai" | "anthropic" | "azure-openai-responses" | "google-vertex" | "amazon-bedrock" | "ant-ling" | "baseten" | "cerebras" | "cloudflare-ai-gateway" | "cloudflare-workers-ai" | ... 28 more ... | "zai-coding-cn"' and '"radius"' have no overlap.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software engineer must fix the build, re-run with log output, verify, resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — catalog-oauth-capability · 09-catalog-oauth-capability

**Cycle.** Re-verification for Task `09-catalog-oauth-capability`.
**Files changed.**

- none — production implementation already satisfies Story 9; remaining diagnostics target test fixtures.
  **Seam (GREEN).** `CatalogProvider.oauth` stays required, and `PiAiModelCatalog` returns the required member.
  **Refactor.** deferred: the test-engineer must update the stale catalog fixtures.
  **Build check.**
- typecheck: exit 2 — `complete-provider-login.test.ts:112` and `register-provider.test.ts:290` omit `oauth`; `pi-ai.test.ts:66` compares the installed provider union with `"radius"`.
  **Assumptions.**
- VERIFIED: Story 9 requires `oauth` as a required `CatalogProvider` member.
- OPEN: `src/commands/provider/complete-provider-login.test.ts:112` — add `oauth: null` to the catalog fixture.
- OPEN: `src/commands/provider/register-provider.test.ts:290` — add `oauth: null` to the catalog fixture.
- OPEN: `src/services/model-catalog/pi-ai.test.ts:66` — preserve the radius assertion without comparing the narrowed provider-id union directly.

ATTEMPT-FAILED: 09-catalog-oauth-capability — typecheck remains blocked by three stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

src/commands/provider/complete-provider-login.test.ts(112,7): error TS2741: Property 'oauth' is missing in type '{ id: string; name: string; baseUrl: null; requiresBaseUrl: false; models: Readonly<{ id: string; name: string; api: string; provider: string; baseUrl: string; reasoning: boolean; input: readonly string[]; cost: CatalogModelCost; contextWindow: number; maxTokens: number; }>[]; }' but required in type 'Readonly<{ id: string; name: string; baseUrl: string | null; requiresBaseUrl: boolean; oauth: Readonly<{ label: string; }> | null; models: readonly Readonly<{ id: string; name: string; api: string; provider: string; ... 5 more ...; maxTokens: number; }>[]; }>'.
src/commands/provider/register-provider.test.ts(290,9): error TS2741: Property 'oauth' is missing in type '{ id: string; name: string; baseUrl: null; requiresBaseUrl: false; models: Readonly<{ id: string; name: string; api: string; provider: string; baseUrl: string; reasoning: boolean; input: readonly string[]; cost: CatalogModelCost; contextWindow: number; maxTokens: number; }>[]; }' but required in type 'Readonly<{ id: string; name: string; baseUrl: string | null; requiresBaseUrl: boolean; oauth: Readonly<{ label: string; }> | null; models: readonly Readonly<{ id: string; name: string; api: string; provider: string; ... 5 more ...; maxTokens: number; }>[]; }>'.
src/services/model-catalog/pi-ai.test.ts(66,50): error TS2367: This comparison appears to be unintentional because the types '"openai" | "anthropic" | "azure-openai-responses" | "google-vertex" | "amazon-bedrock" | "ant-ling" | "baseten" | "cerebras" | "cloudflare-ai-gateway" | "cloudflare-workers-ai" | ... 28 more ... | "zai-coding-cn"' and '"radius"' have no overlap.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software engineer must fix the build, re-run with log output, verify, resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — catalog-oauth-capability · 09-catalog-oauth-capability

**Cycle.** Re-verification for Task `09-catalog-oauth-capability`.
**Files changed.**

- none — production implementation already satisfies Story 9; diagnostics target test fixtures.
  **Seam (GREEN).** `CatalogProvider.oauth` remains required, and `PiAiModelCatalog` returns the required member.
  **Refactor.** deferred: the test-engineer must update the stale catalog fixtures.
  **Build check.**
- typecheck: exit 2 — `complete-provider-login.test.ts:112` and `register-provider.test.ts:290` omit `oauth`; `pi-ai.test.ts:66` compares the installed provider union with `"radius"`.
  **Assumptions.**
- VERIFIED: Story 9 requires `oauth` as a required `CatalogProvider` member.
- B1 - status:OPEN - action:YES - `src/commands/provider/complete-provider-login.test.ts:112` - `OPEN:` add `oauth: null` to the catalog fixture - fix:add the required fixture member - why:the production type must remain required.
- B2 - status:OPEN - action:YES - `src/commands/provider/register-provider.test.ts:290` - `OPEN:` add `oauth: null` to the catalog fixture - fix:add the required fixture member - why:the production type must remain required.
- B3 - status:OPEN - action:YES - `src/services/model-catalog/pi-ai.test.ts:66` - `OPEN:` preserve the radius assertion without comparing the narrowed provider-id union directly - fix:widen the test value before comparison - why:the runtime assertion must compile against the installed provider type.

ATTEMPT-FAILED: 09-catalog-oauth-capability — typecheck remains blocked by three stale test fixtures in the test-engineer's lane.

END: SOFTWARE-ENGINEER
DEBATE_GUIDELINE: 09-catalog-oauth-capability — repair three catalog test type errors with accurate OAuth semantics
GUIDELINE: At src/commands/provider/complete-provider-login.test.ts:112, add oauth: { label: "OpenAI (ChatGPT Plus/Pro)" } after requiresBaseUrl in the openai-codex provider fixture.
GUIDELINE: At src/commands/provider/register-provider.test.ts:290, add the same non-null OAuth label to the oauthCatalog openai-codex provider fixture.
GUIDELINE: At src/services/model-catalog/pi-ai.test.ts:66, type the getBuiltinProviders callback parameter as string before comparing it with radius.
GUIDELINE: Run npm run verify:handoff, then the Story focused tests and npm run verify; require VERIFY: PASS and the EPIC Proof before completion.

## TEST-ENGINEER — contract-operations · 10-contract-operations

**Cycle.** Confirmed GREEN for Task `09-catalog-oauth-capability`; RED for Task `10-contract-operations` (`src/http/contract/credential.test.ts`, `src/http/contract/registry.test.ts`, `src/http/contract/parity.test.ts`, `src/http/contract/openapi.test.ts`).
**Prior GREEN.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `npm test -- src/services/model-catalog/pi-ai.test.ts src/queries/provider/read-catalog.test.ts` — exit 0 — `ℹ pass 27`.
  **Test written.**
- file: `src/http/contract/credential.test.ts` (edited) — suite: `src/http/contract/credential.test` — methods: `provider.loginStart is a phase-2 memory route with its exact schemas`, `provider.loginComplete is a phase-2 memory route with its exact schemas`, `provider.loginCancel is a phase-2 memory route with a 204 success`, `every example parses against its own strict schema and envelope`, `the start response admits exactly one arm per method`, `accepts an llm registration with no transport`, `accepts an llm registration with transport api-key`, `accepts the oauth register arm`, `refuses an oauth register arm carrying an apiKey`, `refuses a login id that is not a login identity`, `the catalogue provider carries a nullable oauth member`, `the register request keeps two kind branches and admits two llm payloads`.
- file: `src/http/contract/registry.test.ts` (edited) — suite: `src/http/contract/registry.test` — methods: updated operation, route, lifecycle, request, response, POST-policy, memory-policy, and replayable-status assertions; `accepts the three login tuples`.
- file: `src/http/contract/parity.test.ts` (edited) — suite: `src/http/contract/parity.test` — methods: `matches the routed and stubbed matrix exactly`, `pins the four deferred rows`.
- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi.test` — methods: updated path, operation, schema, event-catalogue, and closure assertions; exempted the 204 cancel status.
- file: `src/http/contract/example.test.ts` (edited) — suite: `src/http/contract/example.test` — method: `every example parses against its declared schema` now includes the three login operations.
- files: `src/commands/provider/complete-provider-login.test.ts`, `src/commands/provider/register-provider.test.ts`, `src/services/model-catalog/pi-ai.test.ts` (edited) — repaired the three widened-catalog fixtures required by Story 9.
- asserts: The contract exposes exact login routes, strict two-arm challenges, the widened registration and catalogue schemas, 204 cancellation, updated registry counts, OpenAPI closure, and route parity.
  **RED proof.**
- command: `npm test -- src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/openapi.test.ts`
- exit: non-zero — failure: `SyntaxError: The requested module './credential.ts' does not provide an export named 'providerLoginCancelExamples'`
- typecheck probe: `npm run typecheck` — expected missing login exports only (`TS2305`/`TS2724`); no `TS2307` was reported.
  **Open to Software Engineer.**
- `src/http/contract/credential.ts` — export the login request, challenge, response, and example schemas; expose the nullable `oauth` catalogue member; widen `providerRegisterRequest`; and declare the three operation entries with the fields asserted by these tests.
- `docs/proposal/api/credential.md` — include the three exact routed login rows required by the parity assertions.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — contract-operations · 10-contract-operations

**Cycle.** GREEN+REFACTOR for `src/http/contract/credential.test.ts` and related contract tests.
**Files changed.**

- `src/http/contract/credential.ts` (edited) — login schemas, OAuth registration union, catalogue capability and routes.
- `docs/proposal/api/credential.md` (edited) — three routed provider login rows.
  **Seam (GREEN).** The contract exposes strict login operations, transport-specific registration, and the nullable OAuth catalogue member.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: The cancellation example omits its success property so it remains a body-less JSON example.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — contract-operations · 10-contract-operations re-verification

**Cycle.** Confirm GREEN for Task `10-contract-operations`.
**Handoff re-verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Confirm proof.**
- command: `npm test -- src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/openapi.test.ts`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: provider.loginCancel has no content`
  **Finding.**
- `src/http/contract/openapi.test.ts:609` still rejects the contract's bodyless `provider.loginCancel` response.

ATTEMPT-FAILED: 10-contract-operations — focused contract tests remain red because the bodyless cancel route fails the non-empty response assertion

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — contract-operations · 10-contract-operations

**Cycle.** Re-verification for Task `10-contract-operations`.
**Files changed.**

- none — no production change can satisfy the stale body-content assertion without violating the bodyless 204 contract.
  **Seam (GREEN).** The contract keeps `provider.loginCancel` as a bodyless 204 operation, as required by Story 10.
  **Refactor.** deferred: the test-engineer must exempt `provider.loginCancel` from the non-empty response-body assertion.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `provider.loginCancel` has `successStatus: 204` and no response schema in `src/http/contract/credential.ts`.
- B1 - status:OPEN - action:YES - `src/http/contract/openapi.test.ts:596-613` - exempt `provider.loginCancel` from the non-empty response-body assertion - fix:allow the declared 204 operation to omit `success.content` - why:Story 10 and the HTTP handler contract require a bodyless cancellation response.

ATTEMPT-FAILED: 10-contract-operations — confirmation remains red because the test requires content for the bodyless 204 cancellation response

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — handlers-refusals-and-wiring · 11-handlers-refusals-and-wiring

**Cycle.** Confirmed GREEN for Task `10-contract-operations`; RED for Task `11-handlers-refusals-and-wiring` (`src/http/server/credential/start-provider-login.test.ts`, `src/http/server/credential/complete-provider-login.test.ts`, `src/http/server/credential/cancel-provider-login.test.ts`, `src/http/server/credential/refusals.test.ts`, `src/main.test.ts`).
**Prior GREEN.**

- `npm test -- src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/openapi.test.ts` — exit 0 — `ℹ pass 143`.
  **Test written.**
- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi.test` — method: `every routed operation except cancellation resolves to a non-empty response body`
- file: `src/http/server/credential/start-provider-login.test.ts` (new) — suite: `src/http/server/credential/start-provider-login.test` — methods: `POST /v1/provider/login answers 200 with the device challenge and passes the parsed body`, `passes the answers map through unchanged`, `refuses an invalid body with 400 before calling the command`, `maps login-in-progress to 400 invalid-request with the refusal`, `maps login-input-required to 400 and carries the prompt message in details.detail`, `maps provider-not-oauth-capable to 400`
- file: `src/http/server/credential/complete-provider-login.test.ts` (new) — suite: `src/http/server/credential/complete-provider-login.test` — methods: `POST /v1/provider/login/complete answers 200 with the models`, `omits code when the body omits it`, `passes the exact code when the body carries it`, `maps not-found to 404`, `maps login-pending to 400 invalid-request with the refusal`, `maps code-not-accepted, code-required, login-expired and login-lost to 400`
- file: `src/http/server/credential/cancel-provider-login.test.ts` (new) — suite: `src/http/server/credential/cancel-provider-login.test` — methods: `POST /v1/provider/login/cancel answers 204 with no body`, `passes the parsed loginId`, `maps not-found to 404`, `refuses an invalid body with 400`
- file: `src/http/server/credential/refusals.test.ts` (edited) — suite: `src/http/server/credential/refusals.test` — methods: `StartProviderLoginError → invalid-request carrying refusal and detail`, `CompleteProviderLoginError not-found → not-found`, `CompleteProviderLoginError login-pending → invalid-request`, `CancelProviderLoginError → not-found`
- file: `src/main.test.ts` (edited) — suite: `src/main.test` — fixture entries: `provider.loginCancel`, `provider.loginComplete`, `provider.loginStart`
- asserts: The three handlers parse and forward inputs, preserve absent codes, return the declared statuses, map refusals, and bind every route without the shared 501.
  **RED proof.**
- command: `npm test -- src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/http/server/credential/refusals.test.ts src/main.test.ts`
- exit: non-zero — failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/http/server/credential/cancel-provider-login.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/.worktree/engine/feat/045-subscription-authentication-for-llm-providers/src/http/server/credential/cancel-provider-login.test.ts`; `AssertionError [ERR_ASSERTION]: provider.loginCancel answered 501`
- stub probe: `src/http/server/credential/start-provider-login.ts` — 3 errors found in `src/http/server/credential/start-provider-login.test.ts`, fixed by the declared dependency signature
- stub probe: `src/http/server/credential/complete-provider-login.ts` — 4 errors found in `src/http/server/credential/complete-provider-login.test.ts`, fixed by the declared dependency signature
- stub probe: `src/http/server/credential/cancel-provider-login.ts` — 1 error found in `src/http/server/credential/cancel-provider-login.test.ts`, fixed by the declared dependency signature
- stub re-check: `npm run typecheck` — exit 0; all temporary stubs were removed before handoff
  **Open to Software Engineer.**
- `src/http/server/credential/start-provider-login.ts` — export `StartProviderLoginHandlerDependencies` with `startProviderLogin(input: StartProviderLoginInput): Promise<StartProviderLoginResult>` and `startProviderLoginHandler(dependencies): Handler`.
- `src/http/server/credential/complete-provider-login.ts` — export `CompleteProviderLoginHandlerDependencies` with `completeProviderLogin(input: CompleteProviderLoginInput): Promise<CompleteProviderLoginResult>` and `completeProviderLoginHandler(dependencies): Handler`.
- `src/http/server/credential/cancel-provider-login.ts` — export `CancelProviderLoginHandlerDependencies` with `cancelProviderLogin(input: CancelProviderLoginInput): Promise<void>` and `cancelProviderLoginHandler(dependencies): Handler`.
- `src/http/server/credential/refusals.ts` — map `StartProviderLoginError`, `CompleteProviderLoginError`, and `CancelProviderLoginError` through `toHttpError` with the statuses and details asserted by the tests.
- `src/main.ts` — bind `provider.loginStart`, `provider.loginComplete`, and `provider.loginCancel` to their command handlers.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — handlers-refusals-and-wiring · 11-handlers-refusals-and-wiring

**Cycle.** GREEN+REFACTOR for the three login handler tests, refusal tests and main wiring.
**Files changed.**

- `src/http/server/credential/start-provider-login.ts` (new) — parses and dispatches login starts.
- `src/http/server/credential/complete-provider-login.ts` (new) — preserves absent completion codes.
- `src/http/server/credential/cancel-provider-login.ts` (new) — dispatches cancellation and returns 204.
- `src/http/server/credential/refusals.ts` (edited) — maps the three login command errors.
- `src/main.ts` (edited) — binds all three login handlers to their commands.
  **Seam (GREEN).** The handlers parse contract bodies, call one command, format results, and map refusals through `toHttpError`.
  **Refactor.** No named refactor exists in the Story.
  **Build check.**
- typecheck: exit 0
- runtime smoke: `npm start -- --help` exit 0
  **Assumptions.**
- VERIFIED: The cancellation handler uses the existing `EmptyResult` with status 204.
- VERIFIED: The composition root supplies the command dependencies specified by Story 11.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — proposal-documents · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `12-proposal-documents`.
**Story file.** `.agents/plan/stories/045-subscription-authentication-for-llm-providers/12-proposal-documents.md`
**Tasks forwarded to Software Engineer.**

- `12-proposal-documents`: `docs/proposal/api/credential.md`, `docs/proposal/api/README.md`, `docs/proposal/phase-2/providers-and-credentials.md` — record the subscription sign-in flow, its constraints, and the approved deployment decisions.
  **No RED phase.** Coverage is owned by the Story verification gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file's Action sections.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — proposal-documents · 12-proposal-documents

**Cycle.** GREEN-ONLY implementation for Task `12-proposal-documents`.
**Files changed.**

- `docs/proposal/api/credential.md` (edited) — route matrix, subscription sign-in flow, response shapes and constraints.
- `docs/proposal/api/README.md` (edited) — the `provider.loginCancel` 204 exception.
- `docs/proposal/phase-2/providers-and-credentials.md` (edited) — encrypted login storage, OAuth refresh behavior, deployment decisions and irrecoverable credentials.
  **Seam (GREEN).** The proposal documents now record the delivered subscription sign-in flow and its exact route contract.
  **Refactor.** No named refactor exists in the Story; formatted the three amended proposal files with Prettier.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `docs/proposal/database/provider_login.md` already contains the migration-matching SQL fence and required no edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — EPIC verification · widened contract expectations

**Cycle.** Full-gate re-verification after GREEN-only Task `12-proposal-documents`; handoff is blocked.
**Test written.**

- file: `src/cli/parity.test.ts`, `src/cli/repository/register.test.ts`, `src/commands/provider/set-default-provider.test.ts` (edited) — suites: CLI parity, repository registration, provider default — methods: widened routed-operation set and api-key transport fixtures
- file: `src/http/contract/coverage.test.ts`, `src/http/contract/openapi-source.test.ts`, `src/http/contract/runtime-matrix.test.ts`, `src/http/contract/system.test.ts` (edited) — suites: contract coverage, source publication, runtime matrix, system contract — methods: OAuth fields, bodyless cancellation, catalogue count, and routed-operation counts
- file: `src/http/server/app.handler-result.test.ts`, `src/http/server/app.test.ts`, `src/http/server/dispatch.test.ts`, `src/http/server/route.test.ts` (edited) — suites: handler results, app, dispatch, route — methods: login-handler statuses and widened route counts
- file: `src/queries/provider/show-provider.test.ts`, `src/services/provider-auth/credential-writer.test.ts`, `src/services/provider-auth/pi-ai.test.ts` (edited) — suites: provider projection, credential writer, pi-ai adapter — methods: transport projection, event readback, and current OAuth model fixture
- asserts: Existing test expectations now cover the delivered OAuth transport, three login operations, bodyless cancellation, and current installed model identifiers.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `ℹ tests 5756`, `ℹ pass 5746`, `ℹ fail 10`
- representative failure: `✖ dereferences to the same document as the canonical master` — `38 !== 37`
  **Handoff re-verification.**
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Open to Software Engineer.**
- `scripts/publish-contract.source.test.ts` — its catalogue assertion must match the current published event-payload catalogue.
- `scripts/publish-contract.test.ts` — its publication assertions must cover all emitted examples, the bodyless `provider.loginCancel` response, and the two transport branches.
- `src/http/contract/field-decisions.fixture.ts` — exported `fieldDecisions: readonly string[]` must match the current registry schema fields, including OAuth and login fields.
- `docs/proposal/phase-1/runtime-capability-matrix.md` — the operation matrix must name `provider.loginCancel`, `provider.loginComplete`, and `provider.loginStart` in registry order.

ATTEMPT-FAILED: 12-proposal-documents — full `npm test` remains red with ten publication, schema-fixture, and runtime-matrix expectation failures

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC verification · widened contract expectations

**Cycle.** Re-verification for Task `12-proposal-documents`.
**Files changed.**

- `docs/proposal/phase-1/runtime-capability-matrix.md` (edited) — added the three login operations and updated runtime counts.
- `.agents/tdd/memory/software-engineer/2026-08-30.md` (edited) — recorded the verification decision.
  **Seam (GREEN).** The runtime matrix now lists all 48 routed operations in registry order with nine cells per row.
  **Refactor.** Applied the required matrix count and operation synchronization; deferred test-owned expectation updates.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Login operations use SQLite storage, memory idempotency, and Node-only support in the runtime matrix.
- OPEN: `scripts/publish-contract.source.test.ts` — update the event-payload catalogue expectation from 37 to 38.
- OPEN: `scripts/publish-contract.test.ts` — update publication expectations for 47 examples, cancellation without a body, and both transport branches.
- OPEN: `src/http/contract/field-decisions.fixture.ts` — add the current OAuth and login schema field decisions.

ATTEMPT-FAILED: 12-proposal-documents — full-gate confirmation remains blocked by test-engineer-owned publication and schema fixtures

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — build proof failed

**Cycle.** Blocked — software-engineer build verification failed
**Verification result.**

```text
> kanthord@27.8.1 verify:handoff
> node scripts/verify-handoff.mjs

scripts/publish-contract.test.ts(316,36): error TS18048: 'entry.response' is possibly 'undefined'.
VERIFY: FAIL — npm run typecheck exited 2
```

**Action required.** Software engineer must fix the build, re-run with log output, verify, resubmit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC verification · build re-verification

**Cycle.** Re-verification for Task `12-proposal-documents`.
**Files changed.**

- none — the remaining type error is in a test-engineer-owned test.
  **Seam (GREEN).** The bodyless `provider.loginCancel` contract remains unchanged.
  **Refactor.** deferred: the test must retain the narrowed response in a local value before the assertion callback.
  **Build check.**
- typecheck: exit 2 — `scripts/publish-contract.test.ts:316` reports `TS18048` because `entry.response` is not narrowed inside the callback.
  **Assumptions.**
- OPEN: `scripts/publish-contract.test.ts:316` — preserve the checked response in a local value before calling `assert.doesNotThrow`; this test belongs to the test-engineer lane.

ATTEMPT-FAILED: 12-proposal-documents — typecheck is blocked by an unsafe optional-response access in a test-engineer-owned test.

END: SOFTWARE-ENGINEER
DEBATE_GUIDELINE: 12-proposal-documents — narrow the optional published response in the test-engineer lane before the full gate
GUIDELINE: At scripts/publish-contract.test.ts:312-317, assign const response = entry.response before the branch, test response === undefined, and call response.parse inside assert.doesNotThrow.
GUIDELINE: Keep the provider.loginCancel undefined-response branch unchanged so the published 204 example has no success body.
GUIDELINE: Run npm run verify:handoff, npm run verify, and the complete EPIC Proof; append readiness only when every command passes and the Proof prints PASS EPIC-045.

## TEST-ENGINEER — EPIC verification · field-decision fixture

**Cycle.** Full-gate re-verification after GREEN-only Task `12-proposal-documents`; the EPIC gate remains red.
**Test written.**

- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — method: `each published example still satisfies its schema`
- asserts: The bodyless cancellation example omits success while every response-bearing example parses against its schema.
  **Handoff re-verification.**
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Verification result.**
- command: `npm run verify`
- exit: non-zero — failure: `✖ every field in the registry answers required, nullability and enum, matching the reviewed fixture`
- summary: `ℹ tests 5756`, `ℹ pass 5755`, `ℹ fail 1`
  **Open to Software Engineer.**
- `src/http/contract/field-decisions.fixture.ts` — exported `fieldDecisions: readonly string[]` must match the current registry fields for OAuth projections, login operations, and registration arms.

ATTEMPT-FAILED: 12-proposal-documents — `npm run verify` remains red because the reviewed field-decision fixture omits the delivered OAuth and login fields

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC verification · field-decision fixture

**Cycle.** GREEN+REFACTOR for `src/http/contract/coverage.test.ts`.
**Files changed.**

- `src/http/contract/field-decisions.fixture.ts` (edited) — synchronized OAuth projections, login operations and registration arms.
  **Seam (GREEN).** The reviewed field decisions now match every current registry schema field.
  **Refactor.** Replaced stale projection and registration paths with their transport-union paths.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: A registry-schema diagnostic reports `FIELD DECISIONS: MATCH` after the fixture update.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All twelve Story gates and both EPIC gate parts pass.

- handoff (`npm run verify:handoff`) — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- typecheck (`npm run typecheck`, through `npm run verify`) — exit 0.
- unit (`npm test`, through `npm run verify`) — exit 0 — `ℹ pass 5756`, `ℹ fail 0`.
- Gates (`npm run verify`) — exit 0.
  **Proof.** `node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045"` — exit 0 — `PASS EPIC-045`.
  **Tasks closed.** 12 across 12 Stories; no Story remains outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045") — "PASS EPIC-045"
- stories: 12/12 complete
- date: 2026-08-30
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 1 action:YES finding(s) to the TDD loop; 1 action:NO finding(s) recorded for the human.
BLOCKER: serialized-secret-absence-is-not-asserted — Add one shared assertion across serialized operation responses, projections, event payloads, and error details for every fixture secret.
INFO: concurrent-complete-can-delete-the-winning-row — Completion ownership needs a human architecture decision before code changes; concurrent keyless completion can delete the winning replay row.

## TEST-ENGINEER — implementation ready for review

**Review-blocker regression.** Closed `serialized-secret-absence-is-not-asserted`.

- `src/commands/provider/complete-provider-login.test.ts` (edited) — suite: `src/commands/provider/complete-provider-login.test` — method: `keeps every OAuth fixture secret out of serialized public outputs`.
- `test/helpers/secret-absence.ts` (new) — shared assertion checks operation responses, projections, event payloads, and error details against every fixture secret.
- Characterization sensitivity: the focused test passes for production outputs and proves the assertion rejects an injected fixture-secret leak.
- focused (`npm test -- src/commands/provider/complete-provider-login.test.ts`) — exit 0 — `ℹ pass 18`, `ℹ fail 0`.
  **EPIC verification gate.** All twelve Story gates, the review regression, and both EPIC gate parts pass.
- handoff (`npm run verify:handoff`) — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- typecheck (`npm run typecheck`, through `npm run verify`) — exit 0.
- unit (`npm test`, through `npm run verify`) — exit 0 — `ℹ pass 5758`, `ℹ fail 0`.
- Gates (`npm run verify`) — exit 0.
  **Proof.** `node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045"` — exit 0 — `PASS EPIC-045`.
  **Tasks closed.** 12 across 12 Stories; no Story remains outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045") — "PASS EPIC-045"
- stories: 12/12 complete
- date: 2026-08-30
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: FAIL — B1 `concurrent completion ownership` is action:YES, not a deferred architecture decision.

The reviewer deferred B1 on the ground that the ownership layer is undecided. The EPIC decides one half of
it and leaves the other half open, and neither half needs a new architecture decision.

**Decided by the EPIC.** A `completed` row replays and is never corrupted by a concurrent `complete`
(lines ~205-214, ~336-342). `src/commands/provider/complete-provider-login.ts` breaks that: the
`outcome.status === "lost"` branch runs `DELETE FROM provider_login WHERE id = ?` with no state guard, so
a loser deletes the row a concurrent winner just completed. Reachable through
`PiAi.completeLogin` (`src/services/provider-auth/pi-ai.ts:373-377`), which returns `lost` for exactly one
reason — the winner's `#forgetLive` (`:424`) already removed the live entry.

**Open, and closed by the same edit.** The EPIC mandates a delete only for the preflight instance
mismatch (line ~289). It mandates no delete for the post-service `lost` arm, and a delete there cannot
distinguish an abandoned flow from a completion still in flight, so it can also destroy the winner in the
reverse interleaving.

**Resolution.** Replace the branch with one read-then-decide transaction, and do not delete on the
pending arm.

- row absent -> `not-found` (line ~215, `provider.register` consumed it).
- row `completed` -> return `readStoredResult(...)` (line ~205).
- row `pending` -> refuse `login-lost`, write nothing. Expiry (line ~236) or `provider.loginCancel`
  (line ~228) reaps the row.

Drop `abortLogin` from that branch. A `lost` outcome proves the live entry was already absent, and the
`loginId` is a ULID, so the call can never find an entry.

**Required coverage.** Two tests with a deferred-controlled `ProviderAuth` mock, both commands started
before either is awaited. Winner-first: the loser returns the winner's exact `{ loginId, models }`, one
row survives as `completed`, `abortLogin` count is 0. Loser-first: the loser throws `login-lost`, the row
stays `pending`, the winner then commits and returns its models, and a later `loginComplete` replays them.
Sequential awaits cannot exercise either race — the second call would see `completed` at preflight.

Adjudicated against the `pi` debate engine; it defeated the delete-with-guard variant by the reverse
interleaving, and that is why the pending arm now writes nothing.
BLOCKER: concurrent-completion-ownership — src/commands/provider/complete-provider-login.ts, the `outcome.status === "lost"` branch, deletes the row unconditionally, so a loser destroys the row a concurrent winner just completed. Replace the branch with one read-then-decide `storage.transact`: row absent -> throw `not-found`; row `state = 'completed'` -> return `readStoredResult(dependencies, row)`; row `state = 'pending'` -> throw `login-lost` and write nothing. Remove the `abortLogin` call from that branch — a `lost` outcome proves the live entry was already absent and the loginId is a ULID, so it can never find one.
BLOCKER: concurrent-completion-coverage — src/commands/provider/complete-provider-login.test.ts exercises no concurrent completion. Add two tests with a hand-written `ProviderAuth` mock whose `completeLogin` resolves through test-controlled deferred promises, both `completeProviderLogin` calls started before either is awaited. Winner-first: the loser resolves to the winner's exact `{ loginId, models }`, exactly one row survives with `state = 'completed'` and the winner's `payload_ciphertext` bytes, `completeLogin` ran exactly twice, `abortLogin` ran zero times. Loser-first: the loser throws `login-lost`, the row stays present with `state = 'pending'`, the winner then resolves to its exact models, and a later `completeProviderLogin` replays those exact models. Sequential awaits cannot exercise either race — the second call would observe `completed` at preflight.

## TEST-ENGINEER — review blocker · concurrent-completion-coverage

**Cycle.** RED for review blocker `concurrent-completion-coverage` (`src/commands/provider/complete-provider-login.test.ts`).
**Test written.**

- file: `src/commands/provider/complete-provider-login.test.ts` (edited) — suite: `src/commands/provider/complete-provider-login.test` — methods: `returns the winner's stored result to a concurrent loser`, `leaves the pending row intact when the concurrent loser resolves first`
- file: `src/commands/provider/complete-provider-login.test.ts` (edited) — method `refuses login-lost when the service has forgotten the flow` realigned to the human verdict: the row survives as `pending` and `abortLogin` runs zero times.
- asserts: two `completeProviderLogin` calls started before either is awaited, ordered by test-controlled deferred promises and never by a timer or a sleep. Winner-first — the loser resolves to the winner's exact `{ loginId: LOGIN_ID, models: ["gpt-5-codex", "gpt-5"] }`, exactly one row survives with `state = 'completed'` and `payload_ciphertext` bytes identical to what the winner sealed, `completeLogin` ran exactly twice, `abortLogin` ran zero times. Loser-first — the loser throws `CompleteProviderLoginError` with refusal `login-lost` and writes nothing, the row is still present with `state = 'pending'` and a null payload, the winner then resolves to its exact models, and a later `completeProviderLogin` replays those exact models with no further `completeLogin` call.
  **RED proof.**
- command: `npm test -- src/commands/provider/complete-provider-login.test.ts`
- exit: non-zero — `ℹ pass 17`, `ℹ fail 3`
- failure 1: `✖ returns the winner's stored result to a concurrent loser` — `Error [CompleteProviderLoginError]: provider login login_01HZY8QF3M4N5P6R7S8T9V0W1X is no longer live` at `src/commands/provider/complete-provider-login.ts:191:11` (`refusal: 'login-lost'`)
- failure 2: `✖ leaves the pending row intact when the concurrent loser resolves first` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `0 !== 1` at `src/commands/provider/complete-provider-login.test.ts:883:12` (the row count after the loser resolved)
- failure 3: `✖ refuses login-lost when the service has forgotten the flow` — the realigned single-caller case, same unconditional delete
- stub probe: not applicable — every seam the tests import already exists; `npm run typecheck` exits 0.
  **Open to Software Engineer.**
- `src/commands/provider/complete-provider-login.ts` — the post-service `outcome.status === "lost"` branch, per blocker `concurrent-completion-ownership`. The tests import `completeProviderLogin`, `CompleteProviderLoginError` and `CompleteProviderLoginDependencies` from that module; no signature changes.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker · concurrent-completion-ownership

**Review blocker addressed.** BLOCKER: concurrent-completion-ownership — src/commands/provider/complete-provider-login.ts, the `outcome.status === "lost"` branch, deletes the row unconditionally, so a loser destroys the row a concurrent winner just completed. Replace the branch with one read-then-decide `storage.transact`: row absent -> throw `not-found`; row `state = 'completed'` -> return `readStoredResult(dependencies, row)`; row `state = 'pending'` -> throw `login-lost` and write nothing. Remove the `abortLogin` call from that branch — a `lost` outcome proves the live entry was already absent and the loginId is a ULID, so it can never find one.

**Cycle.** GREEN+REFACTOR for `src/commands/provider/complete-provider-login.test.ts`.
**Files changed.**

- `src/commands/provider/complete-provider-login.ts` (edited) — new `LostResolution` union; the post-service `lost` branch now reads and decides in one transaction.
  **Seam (GREEN).** The `lost` arm opens one `dependencies.storage.transact<LostResolution>` that selects the row and returns a discriminated result: absent -> `not-found` throw with the same message as the preflight `not-found`; `completed` -> `readStoredResult(dependencies, row)`, so a concurrent loser returns the winner's stored `{ loginId, models }`; `pending` -> `login-lost` throw with no write, so the pending row survives for expiry or `provider.loginCancel` to reap. The branch issues no `DELETE` and no `abortLogin`.
  **Refactor.** Modelled the branch's outcome as `LostResolution`, matching the existing `Preflight` / `CompletionWrite` discriminated-union style, so the transaction decides and the caller only formats.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: only two `abortLogin` calls remain in the file, both in the preflight expired and instance-mismatch arms — `grep -n "abortLogin" src/commands/provider/complete-provider-login.ts` reports lines 138 and 146.
- VERIFIED: the preflight transaction, the completion write transaction and `readStoredResult` are unchanged, and no exported signature changed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Handoff verification gate.** The software-engineer's last turn claims `typecheck: exit 0`. Independently re-verified.

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Confirm GREEN — review blockers `concurrent-completion-ownership` and `concurrent-completion-coverage`.**

- command: `npm test -- src/commands/provider/complete-provider-login.test.ts` — exit 0 — `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`.
- `✔ returns the winner's stored result to a concurrent loser`
- `✔ leaves the pending row intact when the concurrent loser resolves first`
- `✔ refuses login-lost when the service has forgotten the flow`

**Characterization sensitivity — the loser-first test rejects the guarded-delete variant.**

- Variant injected temporarily into the post-service `lost` branch of `src/commands/provider/complete-provider-login.ts`: `DELETE FROM provider_login WHERE id = ? AND state = 'pending'` before the `pending` resolution is returned.
- Observation under the variant: exit non-zero — `ℹ pass 18`, `ℹ fail 2` — `✖ leaves the pending row intact when the concurrent loser resolves first` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `0 !== 1` at `src/commands/provider/complete-provider-login.test.ts:884:12`; `✖ refuses login-lost when the service has forgotten the flow` fails the same way at `:729:12`. The human verdict's reverse-interleaving argument is therefore pinned by the suite, not only by the implementation.
- Reverted. `src/commands/provider/complete-provider-login.ts` is byte-identical to the software-engineer's committed state — `md5` `6953c76c8b58a7359d64fddd07190261` before and after, `diff` reports no difference.
- Observation after the revert: exit 0 — `ℹ tests 20`, `ℹ pass 20`, `ℹ fail 0`.

**EPIC verification gate.** Both parts run this turn.

- handoff (`npm run verify:handoff`) — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- typecheck (`npm run typecheck`, through `npm run verify`) — exit 0.
- unit (`npm test`, through `npm run verify`) — exit 0 — `ℹ tests 5760`, `ℹ suites 532`, `ℹ pass 5760`, `ℹ fail 0`.
- Gates (`npm run verify`) — exit 0; `kanthord: verify db status ok`, `lane-check.test.sh: PASS`, `turn-snapshot.test.sh: PASS`, `memory-append-only.test.sh: PASS`, `PERSONA-SYNC TESTS: PASS`.

**Proof.** `node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045"` — exit 0 — `ℹ tests 349`, `ℹ suites 33`, `ℹ pass 349`, `ℹ fail 0`, and the command printed `PASS EPIC-045`.

**Tasks closed.** 12 across 12 Stories; no Story remains outstanding. Both routed review blockers are closed.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045") — "PASS EPIC-045"
- stories: 12/12 complete
- date: 2026-08-30
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 1 action:YES finding(s) to the TDD loop; 2 action:NO finding(s) recorded for the human.
BLOCKER: additional-properties-exemption-is-too-wide — src/http/contract/coverage.test.ts:137-144 exempts any object node whose `additionalProperties` is an object from the `additionalProperties === false` assertion, so a future `catchall(z.unknown())` in a registered schema would pass silently. The exemption fires for exactly one node today, `provider.loginStart` request `{"type":"object","additionalProperties":{"type":"string"}}` (the `answers` record). Narrow it to a map node — `additionalProperties` is an object AND the node carries no `properties` key — or exempt `provider.loginStart.request` by operation id, matching the named-exemption pattern the EPIC already chose for `provider.loginCancel` at src/http/contract/openapi.test.ts:225-234. Equivalent today, strictly stronger tomorrow. Add a case proving the narrowed guard still rejects a fully open `additionalProperties: {}` node.
INFO: stale-non-goal-in-epic — .agents/plan/epics/045-...md:90-91 still reads "No cancel operation ... It expires", contradicting the Decisions section at :118-119 and :229-236 and the shipped `provider.loginCancel`. NEEDS-HUMAN: amending the EPIC record is the human's edit; nothing routes to the TDD loop.
INFO: story-7-states-the-rejected-lost-arm — .agents/plan/stories/045-.../07-login-commands.md:228-229 and :369-370 still specify the post-service `lost` arm as "delete the row in a second transaction" and test 26 as asserting "zero rows". The binding HUMAN_REVIEW verdict reversed both, and the delivered code and test follow the verdict, so the Story is now the only artifact stating the rejected behaviour — the exact shape a later reader corrects back. NEEDS-HUMAN: plan-record edit, not a code change.

## TEST-ENGINEER — review blocker · additional-properties-exemption-is-too-wide

**Review blocker addressed.** BLOCKER: additional-properties-exemption-is-too-wide — `src/http/contract/coverage.test.ts:137-144` exempted any object node whose `additionalProperties` is an object, so a future `catchall(z.unknown())` would emit `additionalProperties: {}` and pass silently.

**Cycle.** Test-lane repair for review blocker `additional-properties-exemption-is-too-wide` (`src/http/contract/coverage.test.ts`). No production change is needed and none was made.

**Which narrowing, and why.** The **map-node predicate**, not the operation-id exemption. A probe over the live registry — walking every `type: "object"` node of every registered `query`/`request`/`response` schema — reports exactly one node whose `additionalProperties` is not `false`:

```
provider.loginStart request hasProps=false {"type":"object","additionalProperties":{"type":"string"}}
```

`hasProps=false` holds, so the predicate is sufficient today and needs no operation-id list, which is the reviewer's stated preference. The named-exemption fallback was therefore not used.

The predicate is one notch stronger than the reviewer's wording. A node is exempt only when `additionalProperties` is a **non-empty** object **and** the node carries no `properties` key. The extra clause closes the properties-free half of the same hole: `{"type":"object","additionalProperties":{}}` carries no `properties`, so the bare map predicate would exempt it although it is fully open. Requiring a declared value schema rejects it. The live node `{"type":"string"}` is non-empty, so the registry is unaffected.

**Test written.**

- file: `src/http/contract/coverage.test.ts` (edited) — suite: `src/http/contract/coverage.test`
- extracted `isMapNode`, `unknownKeyOffenders` and `collectFixture` from the inline loop, so the guard is one predicate the new cases call directly. `objectNodes` is unchanged.
- method `every closed object node in every registered schema forbids an unknown key` (edited) — now asserts `deepEqual(unknownKeyOffenders(collected), [])`, an exact empty list rather than a per-node loop.
- method `exactly one registered object node is exempt as a map, and it is the provider.loginStart answers record` (new) — pins the exemption's blast radius by value: the exempt label list deep-equals `["provider.loginStart.request"]` and the node deep-equals `{ type: "object", additionalProperties: { type: "string" } }`. A second exempt node anywhere in the registry fails the suite.
- method `the map exemption still reports a fully open object node` (new) — five fixtures through the same `objectNodes` walk, each asserted by exact value:
  - `{type:"object", properties:{name}, required:["name"], additionalProperties:{}}` → `["fixture.openWithProperties.request"]` (the case the blocker names);
  - `{type:"object", additionalProperties:{}}` → `["fixture.openCatchall.request"]` (the properties-free catchall the extra clause closes);
  - `{type:"object", properties:{name}}` with `additionalProperties` absent → `["fixture.openAbsent.response"]`;
  - a closed outer node wrapping an open inner one → `["fixture.nestedOpen.response"]`, so the walk still reaches depth;
  - a closed outer node wrapping a legitimate map property → `[]`, so the narrowing does not over-report.
- asserts: the registry declares no object node that permits an unknown key; the single map exemption is the `provider.loginStart` `answers` record and nothing else; and the narrowed guard still reports a fully open node in four shapes.

**Sensitivity proof — the new case is not vacuous.**

- Temporarily reverted `isMapNode` to the reviewed wide form (`additional !== null && typeof additional === "object"`) and re-ran.
- exit: non-zero — `ℹ fail 1` — `✖ the map exemption still reports a fully open object node` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` `actual: [],` `expected: [ 'fixture.openWithProperties.request' ]`.
- Restored. `diff` against the pre-probe copy reports no difference.

**No schema was edited to make the guard pass.** The narrowed guard reports zero registry nodes on its own; `src/http/contract/credential.ts` and every other contract source are untouched this turn. The only changed file is `src/http/contract/coverage.test.ts`.

**Verification — the file.**

- command: `npm test -- src/http/contract/coverage.test.ts`
- exit: 0 — `ℹ tests 17`, `ℹ suites 1`, `ℹ pass 17`, `ℹ fail 0`.

**Handoff verification gate.**

- `npm run verify:handoff` — exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**EPIC verification gate.** Both parts run this turn.

- typecheck (`npm run typecheck`, through `npm run verify`) — exit 0.
- unit (`npm test`, through `npm run verify`) — exit 0 — `ℹ suites 532`, `ℹ pass 5762`, `ℹ fail 0`. The count rises from 5760 to 5762 by the two new cases.
- Gates (`npm run verify`) — exit 0; `kanthord: verify db status ok`, `lane-check.test.sh: PASS`, `turn-snapshot.test.sh: PASS`, `memory-append-only.test.sh: PASS`, `PERSONA-SYNC TESTS: PASS`.

**Proof.** `node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045"` — exit 0 — `ℹ tests 349`, `ℹ suites 33`, `ℹ pass 349`, `ℹ fail 0`, and the command printed `PASS EPIC-045`.

**Tasks closed.** 12 across 12 Stories; no Story remains outstanding. All three routed review blockers are closed — `concurrent-completion-ownership`, `concurrent-completion-coverage` and `additional-properties-exemption-is-too-wide`.

**Not routed to this loop.** The two `INFO` findings — `stale-non-goal-in-epic` and `story-7-states-the-rejected-lost-arm` — are edits to `.agents/plan/**`, which planning locks. They stay for the human.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/path.test.ts src/domain/provider-payload.test.ts src/services/storage/migration-0010-provider-login.test.ts src/services/provider-auth/pi-ai.test.ts src/commands/provider/start-provider-login.test.ts src/commands/provider/complete-provider-login.test.ts src/commands/provider/cancel-provider-login.test.ts src/commands/provider/register-provider.test.ts src/queries/provider/read-catalog.test.ts src/http/contract/credential.test.ts src/http/contract/registry.test.ts src/http/server/credential/start-provider-login.test.ts src/http/server/credential/complete-provider-login.test.ts src/http/server/credential/cancel-provider-login.test.ts src/main.test.ts && echo "PASS EPIC-045") — "PASS EPIC-045"
- stories: 12/12 complete
- date: 2026-08-30
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_NOTE: both `INFO` findings are closed by plan-record edits. These are `.agents/plan/**` paths, locked to every engineer lane, so no turn could carry them.

- `stale-non-goal-in-epic` — deleted the `No cancel operation.` Non-goal bullet from the EPIC. `provider.loginCancel` ships, and the Decisions section carries its contract; a reworded bullet would only be a half-truth.
- `story-7-states-the-rejected-lost-arm` — `07-login-commands.md` step 2 now states the read-then-decide resolution for `{ status: "lost" }`, and entry 26 now names the single-caller case plus the two concurrent cases with their exact assertions and the deferred-ordering rule.
- Also corrected the related stale claim the reviewer noted: the EPIC said "`github-copilot` and `kimi-coding` return the first". Only `github-copilot` sets `availableModelIds` — `node_modules/@earendil-works/pi-ai/dist/auth/oauth/github-copilot.js` is the sole file in that directory that mentions it. The sentence now names `github-copilot` alone. This closes index finding S1, which was marked FIXED in the Stories while the EPIC text still carried the claim.
- Re-verified after the edits: `npm run verify` exit 0, `ℹ pass 5762`, `ℹ fail 0`; Proof exit 0 printing `PASS EPIC-045` with `ℹ pass 349`.
  HUMAN_REVIEW: PASS
