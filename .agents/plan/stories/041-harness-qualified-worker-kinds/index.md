# EPIC 041 — Harness-qualified worker kinds — stories

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Prereq: EPIC 040 (sequence order).

`workerKinds` gains four harness-qualified values; `plan import` accepts them without
a `worker-unknown` finding; the proposal documents define what a harness-qualified
kind is.

## Dispatch order

1. **Story 1** — must run first; Stories 2, 3, and 4 depend on it.
2. **Stories 2, 3, and 4** — coupled to Story 1; may run after it in any order.
3. **Story 5** — coupled to Story 1; may run after it.
4. **Story 6** — independent of Stories 1–5; may run at any time.

## Stories

- 1 — Extend `workerKinds` and update `worker.test.ts` → `01-domain-worker-kinds.md`
- 2 — Add test cases to plan-candidate and plan-validate tests → `02-import-accepts-harness-worker.md`
- 3 — Add explicit seven-element assertion to sqlite test → `03-plan-store-extended-set.md`
- 4 — Import/export round-trip for a harness-qualified task → `04-import-export-round-trip.md`
- 5 — Claim is indifferent to the worker kind on a task node → `05-claim-ignores-worker-kind.md`
- 6 — Amend proposal docs to define harness-qualified kinds → `06-proposal-defines-harness-kinds.md`

## Facts (needed for implementation)

- `src/domain/worker.ts:3` — `workerKinds` is a three-element `as const` tuple.
- `src/domain/worker.ts:5` — `workerKind = z.enum(workerKinds)` derives from the tuple; no change needed there.
- `src/domain/worker.test.ts:8` — deep-equal assertion names every element of `workerKinds`.
- `src/domain/worker.test.ts:11` — `workerKind.options` deep-equal is a second assertion to update.
- `src/domain/plan-candidate.test.ts:41-45` — module-level `context` uses hardcoded `workerKinds: ["tdd"]`; does not import `workerKinds` from `./worker.ts`.
- `src/domain/plan-candidate.test.ts:695-711` — existing `worker-unknown` test uses `"nope@1"`.
- `src/domain/plan-validate.test.ts:4` — `workerKinds` already imported from `./worker.ts`.
- `src/domain/plan-validate.test.ts:15-19` — `context.workerKinds` is `[...workerKinds]`; after Story 1 this is the full seven-element array.
- `src/services/plan/sqlite.ts:251` — `workerKinds: [...workerKinds]` spreads the production constant; no source change needed.
- `src/services/plan/sqlite.test.ts:20` — `workerKinds` already imported from `../../domain/worker.ts`.
- `src/services/plan/sqlite.test.ts:1940-1977` — existing test asserts `workerKinds: [...workerKinds]` (spread); must be supplemented with an explicit seven-element assertion.
- `docs/proposal/phase-2/agents-and-workers.md:9` — sentence "Kinds are `general@1`, `tdd@1` and `git@1`." is the target.
- `docs/proposal/phase-2/instructions-and-profiles.md:9` — sentence "Worker kinds are `general@1`, `tdd@1` and `git@1`." is the target.
