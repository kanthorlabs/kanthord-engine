# Story 9 — The proposal records the authority model

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Stories 1 to 8.
Kind: story-foundation

EPIC 050 Story 9 created `docs/proposal/phase-2/runs-and-exclusion.md` and recorded the run model,
and EPIC 050.1 Story 9 added the claim half. This story adds the authority half. It draws no path.

## Change

Extend `docs/proposal/phase-2/runs-and-exclusion.md` with:

- **The four authority conditions.** A write is admitted when the run is active, unexpired, bound to the target, and carrying the current fence. State the six refusal codes and their fixed order, and state that a refusal names the run id and the reason only — never the current fence, because handing the replacement value to a writer holding a stale one gives it the authority the raise was meant to remove.
- **The renew.** `expires_at = min(now + runTtlMs, max_lifetime_at)`, `lifetime-exceeded` at `now >= max_lifetime_at`, and that a renew never touches the fence.
- **The release.** A worker voluntarily ends its run with no checkpoint. The node returns to `ready`, the open attempt is cancelled, the run ends and the fence rises.
- **One terminal event per run.** A run that moves from `active` to `ended` appends exactly one of `run.ended` or `run.expired`, never both and never neither, in the same transaction as the transition and the fence raise.
- **The lease renewal is transitional.** The renew renews both leases until EPIC 050.4 removes the node lease, and that removal changes no wire shape.

State no diagram and no seam name. The proposal records behaviour; the stories record the paths.

## Constraints

- Extend the shipped document. Do not create a second one.
- Record no implementation detail: no file path, no dependency key, no SQL.
- Every sentence is a behaviour a test in this epic asserts.

## Verify

```
node --test src/http/contract/proposal-amendment-execution.test.ts
```

1. `"the proposal states the four authority conditions"` — assert the section exists and names all six refusal codes.
2. `"the proposal states the renew formula"`.
3. `"the proposal states one terminal event per run"`.

`pnpm run verify` exits 0. It reads `docs/proposal/` for the parity and error-table comparisons, so a
drift between this document and the contract fails there.

Proof: PASS line delivered — `src/http/contract/proposal-amendment-execution.test.ts` in `PASS EPIC-050.2`.
