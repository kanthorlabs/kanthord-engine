# Plan 03: Tracking Service — the measure `test_floor_share`

## Scope

Repository: `kanthorlabs/kanthord-engine`.

This plan adds the measure `test_floor_share` to `tracking.analytics.duration` (decision D6).

Today `AnalyticsMeasure` holds seven values (`src/tracking/contract.ts:138-146`). `readDuration` answers a percentile item for each measure other than `instance_busy_ratio` (`src/tracking/analytics-duration.ts:351-380`). No measure reads `kanthord.affected.floor_seconds` or `kanthord.affected.total_seconds`.

The plan delivers:

- `test_floor_share` in `AnalyticsMeasure`, with the item `{ key, bucket_start, count, share }`.
- The read of the latest matching span of each group and bucket.
- The description of the operation, the OpenAPI document and `docs/cli/tracking.md`.

Out of scope:

- The writer of the attributes. Plan 02 owns it.
- The dashboard row. Plan 04 owns it.

## Model

Sonnet at high effort. The read follows the pattern of `readBusyRatio` (`src/tracking/analytics-duration.ts:286-349`) with one new rule for the latest span.

## Sources

- `docs/brainstorm/tracking-service.impl.md:347` — the measure and its matching span.
- `docs/brainstorm/tracking-service.impl.md:352` — the item of the measure.
- `docs/brainstorm/tracking-service.impl.md:357-358` — the `group_by` values and the percentile item of the other measures.
- `docs/brainstorm/tracking-service.impl.md:320-329` — the groups, the buckets, the limit and the order of every analytics read.
- `docs/brainstorm/tracking-service.vocabulary.md` "analytics measure" — the closed set of eight values.

## Depends on

- Plan 02 of `dogfood-time/` merged. Start from `origin/main` of `kanthorlabs/kanthord-engine`.
- The tests write the span attributes directly, so this plan does not wait for plan 02 of this set.

## Provides

The contract of plan 04:

| Item                          | Shape                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `AnalyticsMeasure.FloorShare` | `"test_floor_share"`                                                               |
| Item of `test_floor_share`    | `{ key: string \| null; bucket_start: number \| null; count: int; share: number }` |
| Order                         | `bucket_start` ascending, `count` descending, `key` ascending with null last       |

## Tasks

### 03.1 Write the reproducing tests

- Files: `src/tracking/analytics-duration.test.ts`, `src/apps/cli/tracking.test.ts` (edit)
- Do:
  1. In `analytics-duration.test.ts`, add the test "test_floor_share answers the share of the latest release affected span of each group". Write three `worker.verification` spans of one node with `kanthord.verification.kind` `affected` and `kanthord.verification.context` `release`. Give them the start times 1000, 2000 and 3000 and the floor and total seconds 10 of 100, 20 of 100 and 30 of 120. Read with `group_by: node_id` and `bucket: none`. Assert one item with `count: 3` and `share: 0.25`, and no `p50`.
  2. Add the test "test_floor_share skips a span of the evaluation, a span with no total and a span with a total of 0". Assert that these spans add nothing to `count`.
  3. Add the test "test_floor_share keeps one item for each bucket". Use `bucket: day` with spans on two days. Assert two items in the order of `bucket_start`.
  4. Add the test "test_floor_share refuses the group_by worker_instance" with 400 `gateway.request.validation_failed`.
  5. In `tracking.test.ts`, add the test "analytics duration accepts the measure test_floor_share" for `--measure test_floor_share`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/tracking/analytics-duration.test.ts src/apps/cli/tracking.test.ts` fails on the new tests only.

### 03.2 Add the measure and its read

- Files: `src/tracking/contract.ts`, `src/tracking/analytics-duration.ts` (edit)
- Do:
  1. Add `FloorShare: "test_floor_share"` to `AnalyticsMeasure` (`src/tracking/contract.ts:138-146`).
  2. Add `floorShareItemSchema`, a strict object of `key`, `bucket_start`, `count` and `share`. Add it to the item union of the output of `analyticsDuration` (`:787-810`), beside the busy ratio item.
  3. Keep the refinement of `analyticsDurationQuerySchema` (`:531-546`). It already refuses `worker_instance` with every measure other than `instance_busy_ratio`.
  4. In `analytics-duration.ts`, add `readFloorShare`. It reads the spans of `selectedTracesOf` with the operation `worker.verification` and keeps each matching span of decision D6. It groups them with `KEY_OF[query.group_by]` and `bucketStart`. For each group and bucket, it counts the spans and keeps the latest span. `share` is `floor_seconds / total_seconds` of that span.
  5. `readDuration` (`:351-358`) calls `readFloorShare` for `test_floor_share`. Order and cut the items with the helpers of the percentile read, with `count` as the order measure.
  6. Change the description of `analyticsDuration` (`:800`): add "An item of test_floor_share holds the count and the floor share of the latest release affected span only."
- Cite: decision D6; `tracking-service.impl.md:347`, `:352`.
- Verify: the tests of task 03.1 steps 1 to 4 pass.

### 03.3 Accept the measure in the CLI

- Files: `src/apps/cli/tracking.ts` (edit)
- Do:
  1. Keep the parse of `--measure` through `analyticsMeasureSchema` (`:301-311`). It takes the new value with no change.
  2. When the output of `analytics duration` formats an item by its fields, add the case of the share item. Print `share` as the JSON number of the answer.
- Verify: the test of task 03.1 step 5 passes.

### 03.4 Regenerate the OpenAPI document and update the CLI page

- Files: `static/openapi/tracking/analytics.duration.yaml` (generated), `docs/cli/tracking.md` (edit)
- Do:
  1. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the generated change.
  2. In `docs/cli/tracking.md`, add the row `test_floor_share` to the measure table (`:309-317`): "`kanthord.affected.floor_seconds` divided by `kanthord.affected.total_seconds` of the latest `worker.verification` span of the kind `affected` and the context `release` of a group and bucket. A span with no total or a total of 0 is skipped."
  3. Add to the item paragraph (`:340-345`): "An item of `test_floor_share` holds `key`, `bucket_start`, `count` (the matching spans) and `share`, and no percentile."
  4. Run `pnpm exec prettier --write docs/cli/tracking.md`.
- Cite: `engine/AGENTS.md` "Code rules" — change the declarations, never the generated YAML.
- Verify: `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit.

### 03.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Run `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/`. It prints nothing.
- Run `pnpm exec prettier --check docs/cli/tracking.md`.
- Confirm that the tests of task 03.1 failed before task 03.2 and pass after task 03.3.
