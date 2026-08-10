# EPIC 101 — Credential registry completion — stories

Epic: `.agent/plan/epics/101-credential-registry-completion.md`
Prereq: EPIC 100 (sequence order).

The daemon completes provider registry writes, removal safety and master-key startup refusals.

## Dispatch order

Run Stories 1, 2 and 3 in order. Run Stories 4 through 8 as one coupled unit, in numeric order, with no full gate between them. Run Stories 9 and 10 after that unit; they are independent of each other.

## Stories

- 1 — Use one process-wide monotonic ULID factory → `01-monotonic-id-generator.md`
- 2 — Move the nullable provider view type to domain → `02-provider-view-domain-type.md`
- 3 — Stamp and event the first LLM registration → `03-first-registration-stamps-chain.md`
- 4 — Implement provider.setDefault → `04-set-default-provider.md`
- 5 — Implement provider.rename → `05-rename-provider.md`
- 6 — Implement provider.remove and every blocker → `06-remove-provider.md`
- 7 — Route the three provider operations → `07-route-contracts.md`
- 8 — Compose handlers and map refusals → `08-composition-and-refusals.md`
- 9 — Refuse unsafe master-key startup paths → `09-master-key-startup-refusal.md`
- 10 — Label inherited crypto and projection regressions → `10-inherited-regressions.md`

## Facts (needed for implementation)

- `src/services/event/sqlite.ts:94-97` orders events by id, so Story 1 precedes Story 3.
- `src/services/storage/migration-0001-core-entities.ts:13-25` already permits nullable integer `set_default_at`; add no migration.
- `src/services/storage/connection.ts:30-122` uses `BEGIN IMMEDIATE` and rolls back a thrown transaction callback.
- `src/services/storage/migration-0003-execution-and-journal.ts:47-52` makes `attempt.provider_id` a non-null provider foreign key.
- `src/http/server/dispatch.ts:14-46` rejects stubbed routes before handler lookup; Stories 4 through 8 cannot pass the full gate separately.
- `src/http/contract/credential.ts:19-26` already permits `projection: null` and rejects extra response keys.
- `src/services/config/convict.ts:329-380` resolves master-key metadata and content through separate path operations today.
