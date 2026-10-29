# Plan 02: Worker unit — the affected report version 2 and the floor attributes

## Scope

Repository: `kanthorlabs/kanthord-engine`.

This plan makes the worker accept the affected report version 2 with `floor` (decision D4) and write the floor span attributes (decision D5). The ruling of root pull request #275 says: "The worker accepts version 2 before a repository writes it. Version 1 stays valid."

Today the strict schema takes only `version: 1` (`src/worker/unit/affected.ts:49`, `:133-165`). A report with `version: 2` or with `floor` is an invalid report, so a selector that writes version 2 stops the execution with `affected_invalid`. `affectedEnd` writes no floor attribute (`src/worker/unit/method-telemetry.ts:259-310`).

The plan delivers:

- The report schema with `version` 1 or 2 and the optional `floor` of version 2.
- The floor attributes at the end of an `affected` span.

Out of scope:

- A selector that writes version 2. Plan 05 changes the engine selector. The apps selector keeps version 1 (decision D7).
- The root page `docs/explanation/worker-contract.md`. Plan 08 adds the attributes there.
- The analytics read of the attributes. Plan 03 owns it.

## Model

Sonnet at high effort. The change is one schema, one span end and their tests.

## Sources

- `docs/brainstorm/worker-service.impl.md:1595-1598` — `version` 1 or 2, the floor and its keys, a `floor` key in version 1.
- `docs/brainstorm/worker-service.impl.md:1600-1611` — the version 2 example.
- `docs/brainstorm/tracking-service.impl.md:86-88` — the three span attributes.

## Depends on

- Start from `origin/main` of `kanthorlabs/kanthord-engine`. It holds plan 02 of `dogfood-time/` (#379) and plan 01 of this set (#378).
- No file overlaps with plan 03.

## Provides

The contract of plan 05:

| Item                              | Shape                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AffectedReport.version`          | `1 \| 2`                                                                                                    |
| `AffectedReport.floor`            | optional `{ tests: int >= 0; seconds: finite >= 0; total_seconds: finite >= 0 \| null }`, only in version 2 |
| `kanthord.affected.floor_count`   | int, from `floor.tests`                                                                                     |
| `kanthord.affected.floor_seconds` | double, from `floor.seconds`                                                                                |
| `kanthord.affected.total_seconds` | double, from a non-null `floor.total_seconds`                                                               |

## Tasks

### 02.1 Write the reproducing tests

- Files: `src/worker/unit/affected.test.ts` (edit)
- Do:
  1. Add the test "a version 2 report with a floor is a valid report". Parse the version 2 example of `worker-service.impl.md:1600-1611` with the report parser of `src/worker/unit/affected.ts:273-290`. Assert a valid report that keeps `floor`.
  2. Add the test "a version 2 report with no floor is a valid report".
  3. Add the test "a floor key in a version 1 report is an invalid report". Assert the error names `floor`.
  4. Add the test "a total_seconds with the selection related is an invalid report". Use a version 2 report with `selection: "related"` and `total_seconds: 12.5`.
  5. Add the test "a floor with a negative or a fractional test count is an invalid report".
  6. Add the test "an affected span holds the floor attributes of a version 2 report". Run the affected test run of a release with a selector that writes the version 2 example. Assert `kanthord.affected.floor_count` 1, `kanthord.affected.floor_seconds` 41.7 and `kanthord.affected.total_seconds` 1428.5 on the `affected` span.
  7. Add the test "an affected span holds no total_seconds when the floor holds null". Use `selection: "related"` and `total_seconds: null`. Assert `floor_count` and `floor_seconds`, and no `total_seconds`.
  8. Add the test "an affected span of a version 1 report holds no floor attribute".
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/affected.test.ts` fails on the tests of steps 1, 2, 6 and 7 only.

### 02.2 Accept version 2 in the schema

- Files: `src/worker/unit/affected.ts` (edit)
- Do:
  1. Replace `REPORT_VERSION` (`:49`) with the two versions 1 and 2. Keep the name of one constant for each version.
  2. Add `floorSchema`, a strict object of `tests`, `seconds` and `total_seconds` with the shapes of section "Provides".
  3. Add `floor: floorSchema.optional()` to `affectedReportSchema` (`:133-165`). `version` takes 1 or 2.
  4. In `superRefine`, add an issue on `floor` for a version 1 report that holds `floor`. Add an issue on `floor` for a non-null `total_seconds` with a `selection` other than `all`.
  5. Keep every other refinement and every bound.
- Cite: decision D4.
- Verify: the tests of task 02.1 steps 1 to 5 pass.

### 02.3 Write the floor attributes

- Files: `src/worker/unit/method-telemetry.ts`, `src/worker/unit/test-support.ts` (edit)
- Do:
  1. Add `FloorCount: "kanthord.affected.floor_count"`, `FloorSeconds: "kanthord.affected.floor_seconds"` and `TotalSeconds: "kanthord.affected.total_seconds"` to `AffectedAttribute` (`:259-270`).
  2. In `affectedEnd` (`:282-310`), when `report?.floor` exists, write `FloorCount` and `FloorSeconds`. When `report.floor.total_seconds` is not null, write `TotalSeconds`.
  3. Write no floor attribute in `affectedBaseEnd`.
  4. When a test helper of `test-support.ts` builds a report, keep its version 1 default.
- Cite: decision D5.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/affected.test.ts src/worker/unit/release-gate.test.ts src/worker/unit/evaluation.test.ts` passes.

### 02.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 02.1 steps 1, 2, 6 and 7 failed before task 02.2 and pass after task 02.3.
- The pull request body states that the worker accepts version 2 before a repository writes it, with the line of the ruling of root pull request #275.
