# Story 00 — The `integration` mode exists

Epic: `.agent/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`

## Change

- `scripts/e2e/lib/scenario/index.ts:14` — in `ScenarioDeclaration`, replace

  ```ts
  mode: "deterministic" | "deployment";
  ```

  with

  ```ts
  mode: "deterministic" | "integration" | "deployment";
  ```

- `scripts/e2e/lib/bundle.ts:42` — in `Bundle`, replace

  ```ts
  mode: "deterministic" | "deployment";
  ```

  with

  ```ts
  mode: "deterministic" | "integration" | "deployment";
  ```

No other file changes. No scenario declares `integration` yet; Story 01 does.

## Constraints

- Widen only. `deterministic` and `deployment` stay in both unions. `deployment` keeps no
  phase-1 member, because phase 3 uses it.
- `createBundleWriter` takes `mode: Bundle["mode"]` (`scripts/e2e/lib/bundle.ts:106`), so it
  inherits the widening with no edit.

## Verify

- `node --test scripts/e2e/lib/bundle.test.ts` — add one test named
  `a bundle declaring mode integration round-trips through the writer`:
  build a writer with `createBundleWriter({ ... mode: "integration" ... })` copying the input
  shape at `scripts/e2e/lib/bundle.test.ts:22`, call `finish` with
  `{ outcome: "passed", cleanupFailures: [], finishedAt: "2026-01-01T00:00:00.000Z" }`, and
  assert `bundle.mode === "integration"`. Assert the exact string, never a truthy check. Use that
  literal timestamp, never `new Date()`.
- `npm run verify` exits 0.
- Proof: this story delivers no `PASS` line on its own. It is the precondition for the
  `P1-E5` row of Story 01.
