# EPIC 103 — Repository profile and templates — stories

Epic: `.agents/plan/epics/103-repository-profile-and-templates.md`
Prereq: EPIC 102 (sequence order).

A repository carries one `kanthord.profile/v1` profile in SQLite, instantiated from the one `nodejs` template, exported and re-imported byte-identically, with a check that cannot fail rejected by name.

## Dispatch order

Run Stories 1 through 6 in numeric order. Stories 1 and 2 are a **coupled pair**: `src/domain/profile-document.ts` imports `profileChecks` from `src/domain/profile-check.ts`, so write both files before running either test file. Story 3 follows the pair, Story 4 needs 1 through 3, and Story 5 needs 1 through 3. Story 6 is independent of 1 through 5 and may run at any point before Story 7. Run Stories 7, 8, 9 and 10 as one coupled unit, in numeric order, with no full gate between them: `src/http/server/dispatch.ts` rejects a stubbed route before handler lookup, so the three routes stay unreachable until Story 10 lands, and Story 8 edits the same two command files Story 7 creates.

## Stories

- 1 — Declare the document schema and the closed finding list → `01-profile-document-schema.md`
- 2 — Validate the `checks` map and lint a vacuous command → `02-checks-map-and-vacuous-lint.md`
- 3 — Fix the canonical render byte order → `03-canonical-render.md`
- 4 — Parse a markdown profile into findings → `04-markdown-import.md`
- 5 — Ship the `nodejs` template and its digest payload → `05-nodejs-template.md`
- 6 — Add the profile store capability → `06-profile-store.md`
- 7 — Instantiate and import, each in one transaction → `07-instantiate-and-import.md`
- 8 — Append the two profile events → `08-the-two-events.md`
- 9 — Export the stored blob as bytes → `09-export.md`
- 10 — Route the three operations and compose → `10-route-contracts-and-composition.md`

## Facts (needed for implementation)

- `src/domain/profile.ts:7-14` already declares `profileRow`, and `src/domain/rows.ts:34` already registers it. Add no row entity.
- `src/services/storage/migration-0001-core-entities.ts:60-65` already creates the `profile` table with `repository_id TEXT NOT NULL UNIQUE`. Add no migration.
- `src/domain/identity.ts:7,29` already accepts the `profile` identity kind, so `ids.mint("profile")` works today.
- `src/http/contract/path.ts` already registers `profile` as a subresource, and the three path tuples at `src/http/contract/instruction.ts:26-48` are already legal. Change no path.
- EPIC 101 has landed: `src/http/contract/registry.test.ts:34-43` already pins 27 routed and 27 stubbed. EPIC 102 adds the `model` capability and renames `src/domain/layout.test.ts:101` to `fifteen`; Story 6 makes it `sixteen`.
- `src/domain/plan-render.ts:17-39` `quoteScalar` escapes backslash, double quote, LF, CR, TAB and any C0 control or DEL as `\xNN`, and leaves non-ASCII verbatim. It is the one escaping rule.
- `src/domain/plan-path.ts:106-113` `comparePaths` compares by code point, shorter-prefix first. It is the one ordering rule.
- `src/domain/plan-body.ts:21-24` `normalizeBody` maps CRLF and lone CR to LF, strips every trailing newline and re-adds exactly one.
- `src/services/blob/index.ts:21-25` `put(transaction, content)` requires a transaction; `get(hash, transaction?)` takes it second and optional; `hash(content)` is pure. `src/services/blob/sqlite.ts:24-31` is `INSERT ... ON CONFLICT(hash) DO NOTHING`, so an old blob survives an edit.
- `src/services/event/index.ts:5-12` `AppendEventInput` carries no timestamp; `SqliteEventLog.append` derives `occurredAt` from the ULID. No payload may hold a time.
- `src/services/storage/index.ts:32-38` `transact` is synchronous and generic, and `src/services/storage/sqlite.ts:134-141` throws on a nested `transact`. One transaction per command, never two.
- `src/services/event/atomicity.test.ts:38-70` is the atomicity template: a write, then a failing append, then assert zero rows on both sides.
- `test/helpers/database.ts:36` wires the storage clock as `createMockClock({ start: 1700000000000, step: 1000 })`. A command test must pass its own `createMockClock({ start: 1700000000000 })` with no step, or the row timestamp drifts with the call count.
- `src/http/contract/errors.ts:94-98` forces a `details` argument for every `409` code, so `illegal-transition` and `stale-revision` both need a details schema. `illegalTransitionDetails` does not exist yet.
- `src/http/contract/coverage.test.ts:332`, `example.test.ts:8-17` and the `operationAdditions` assertion all scope to `phase-1`, so these three `phase-2` operations change none of them.
- `src/main.test.ts:182-227` requires a fixture key for every routed operation, so flipping a status without adding a fixture fails the gate.
- `src/http/server/app.test.ts:368` and `src/http/server/dispatch.test.ts:194` both count `routed - 2`, not stubbed, because each binds only `system.health` and `system.db`. Both read `25` today and both become `28`. `dispatch.test.ts:458` is a separate stub count and becomes `24`.
- `src/http/contract/openapi.test.ts:205` has a stale title: it says `sixty` while the asserted array holds `62` entries. The correct post-103 number is `70`.
- `test/helpers/rows.ts:21-30` `seedRegistry` inserts three `blob` rows, so no test may assert a zero total blob count.
- The EPIC puts `ids.mint("profile")` and `clock.now()` **inside** the instantiate transaction. Keep them there; a refused call then consumes no id and no clock reading.
- The 400/422 boundary is settled by the human, not open. `profile.instantiate` keeps the strict request schema the EPIC names, so a structural failure answers `400 invalid-request` and only a semantic failure answers `422 profile-invalid`. `check-run-empty` and `check-run-invalid` are therefore reachable through `profile.import` only. Story 10 states the full split.
- An unregistered repository refuses. The EPIC is silent on it, and the human decided: a repository that is not configured yet holds nothing to work on, so `instantiate` and `import` both refuse `repository-not-found` and answer `404 not-found`. This is a settled decision, not an open question.
