# Plan 04: Dashboard — the `Test floor share` row

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan adds the measure `Test floor share` to the `Time` section of `/analytics` (`docs/brainstorm/architecture.impl.md:1551`, `:1555`).

Today the measure select holds six measures (`src/api/types.ts:1621-1628`, `src/lib/analytics-query.ts:60-67`). Every time row shows the count, p50, p90, p99 and max with a percentile bar (`src/lib/analytics-time-rows.ts:39-80`, `src/features/analytics/components/time-row.tsx`).

The plan delivers:

- `test_floor_share` in `ANALYTICS_MEASURES` and the item type `AnalyticsFloorShareItem`.
- The select label `Test floor share`.
- A floor share row: the count, the share as a percent and one bar from 0 to 1.
- The measure in `mock/analytics.mjs`.

Out of scope:

- The engine. Plan 03 owns the measure.
- A trend view of the share. The ruling of root pull request #275 defers it.

## Model

Sonnet at high effort. The plan adds one measure value, one row form and one mock case, and it follows the fixed contract of plan 03.

## Sources

- `docs/brainstorm/architecture.impl.md:1551` — the measure select.
- `docs/brainstorm/architecture.impl.md:1555` — "A `Test floor share` row shows the count and the share as a percent, with one bar from 0 to 1."
- `docs/brainstorm/architecture.impl.md:1559-1561` — the bar is a shadcn `Progress`, and the row text repeats each value.
- `docs/brainstorm/tracking-service.impl.md:352` — the item of the measure.
- `apps/AGENTS.md` "Architecture" — a changed operation also updates `mock/`; `src/api/types.ts` follows the contract.
- `apps/AGENTS.md` "Design" — both widths and the browser check.

## Depends on

- Plan 03 merged to `main` of the engine.
- Start from `origin/main` of `kanthorlabs/kanthord-apps`. No file overlaps with plan 07.

## Provides

The dashboard of the measure. No engine seam.

## Tasks

### 04.1 Write the reproducing tests

- Files: `src/features/analytics/analytics-screen.test.tsx`, `src/lib/analytics-query.test.ts`, `src/lib/analytics-time-rows.test.ts` (edit)
- Do:
  1. In `analytics-screen.test.tsx`, add the test "shows Test floor share as a percent with one bar from 0 to 1". Mount `/analytics?time_measure=test_floor_share`. Answer one item `{ key: null, bucket_start: null, count: 3, share: 0.25 }`. Assert the texts `Count 3` and `25%`, no `p50`, and one progress bar with the value 0.25 of the maximum 1.
  2. In `analytics-query.test.ts`, extend the list of measure labels (`:111`) with `Test floor share`.
  3. In `analytics-time-rows.test.ts`, add the test "a floor share row holds the count and the percent". Assert the fields `Count` and `Share`, the share text `25%` and a bar label that repeats both values.
- Verify: `pnpm exec vitest run src/features/analytics src/lib/analytics-query.test.ts src/lib/analytics-time-rows.test.ts` fails on the new tests only.

### 04.2 Add the measure and its item type

- Files: `src/api/types.ts`, `src/api/resources/tracking.ts`, `src/lib/analytics-query.ts` (edit)
- Do:
  1. Add `"test_floor_share"` to `ANALYTICS_MEASURES` (`src/api/types.ts:1621-1628`).
  2. Add `AnalyticsFloorShareItem` with `key`, `bucket_start`, `count` and `share`.
  3. Type the answer of `readAnalyticsDuration` (`src/api/resources/tracking.ts:88-96`) as a page of `AnalyticsDurationItem` or a page of `AnalyticsFloorShareItem`, by the measure of the query.
  4. Add `test_floor_share: "Test floor share"` to `TIME_MEASURE_LABELS` (`src/lib/analytics-query.ts:60-67`).
- Verify: `pnpm run typecheck` passes or names only the row code of task 04.3.

### 04.3 Show the floor share row

- Files: `src/lib/analytics-time-rows.ts`, `src/features/analytics/use-time.ts`, `src/features/analytics/components/time-section.tsx`, `src/features/analytics/components/floor-share-row.tsx` (new), `mock/analytics.mjs` (edit)
- Do:
  1. In `analytics-time-rows.ts`, add `floorShareRowsOf(items, bucket, group, names)`. A row holds the title, the bucket text, the fields `Count` and `Share`, the share as a whole percent, the bar value `share` of the maximum 1, a bar label with both values and the traces path of the group.
  2. In `use-time.ts`, keep the measure with the page, so the section picks the row form by the measure.
  3. In `floor-share-row.tsx`, render a `DataListItem` with the fields and one `Progress` with `value={share}` and `max={1}`. Compose the shared components only.
  4. In `time-section.tsx`, render `FloorShareRow` for `test_floor_share` and `TimeRow` for every other measure.
  5. In `mock/analytics.mjs`, add `test_floor_share` to `MEASURES` (`:31-38`). Answer the floor share item of the latest `worker.verification` span of each group and bucket, with a `floorShare` value in each mock verification span.
- Cite: `architecture.impl.md:1555`, `:1559-1561`.
- Verify: the tests of task 04.1 pass.

### 04.E Gate

- Run `pnpm verify` in `apps/`.
- Confirm that the tests of task 04.1 failed before task 04.2 and pass after task 04.3.
- Run `pnpm dev:all`. Open `/analytics?time_measure=test_floor_share` at 1280 by 800 and at 390 by 844. Check one row with the count, the percent and the bar, with no horizontal scroll. Attach both screenshots to the pull request body.
