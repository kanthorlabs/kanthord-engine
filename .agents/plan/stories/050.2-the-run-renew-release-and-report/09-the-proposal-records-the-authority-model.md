# Story 9 — The proposal records the authority model

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: Story 1 (`01-run-authority`) through Story 8 (`08-the-policy-amendment-and-the-capability-swap`).
Kind: story-foundation

EPIC 050 Story 7 (`07-the-proposal-records-the-run-model`) created
`docs/proposal/phase-2/runs-and-exclusion.md` and recorded the run model, and EPIC 050.1 Story 9
(`09-the-proposal-records-the-claim`) added the claim half. This story adds the authority half. It draws no path.

## Change

Extend `docs/proposal/phase-2/runs-and-exclusion.md` with:

- **The five authority conditions.** A write is admitted when the run is active, unexpired, held by the caller, bound to the target, and carrying the current fence. State the six refusal codes and their fixed order, and state that a refusal names the run id and the reason only — never the current fence, because handing the replacement value to a writer holding a stale one gives it the authority the raise was meant to remove.
- **The target binding is the run's own node.** A write is admitted only when the run it names is the run of the node it targets. State that the subtree rule governs claim-time exclusion and not authority, that a structural objective run holds no task attempt, and that a subtree-bound structural mutation is a separate admission the epic that ships it declares.
- **A lease fence and a run fence are two counters.** State that a lease fence rises when a lease is taken again and a run fence rises only when a run ends, that a reused objective run makes them diverge, and that the claim response therefore names all four values and a write presents the run fence of the run it names.
- **The renew.** `expires_at = min(now + runTtlMs, max_lifetime_at)`, `lifetime-exceeded` at `now >= max_lifetime_at`, and that a renew never touches the fence.
- **A task renew moves two runs.** The task run it names and the structural run of that task's objective, derived from the node. The claim renews the structural objective run it reuses. State the failure both prevent: the objective run expires under a live task run, and the later attest or close refuses `run-ended`. State that each run clamps to its own `max_lifetime_at`, so `runMaxLifetimeMs` bounds the whole objective attempt, and that one `run.renewed` is appended per run whose `expires_at` moved.
- **The release.** A worker voluntarily ends its run with no checkpoint. The node returns to `ready`, the open attempt is cancelled, the run ends and the fence rises.
- **One terminal event per run.** A run that moves from `active` to `ended` appends exactly one of `run.ended` or `run.expired`, never both and never neither, in the same transaction as the transition and the fence raise.
- **The lease renewal is transitional.** The renew renews both leases until EPIC 050.4 Story 4 (`04-the-renew-drops-the-lease`) removes the node lease, and that removal changes no wire shape.

State no diagram and no seam name. The proposal records behaviour; the stories record the paths.

## Constraints

- Extend the shipped document. Do not create a second one.
- Record no implementation detail: no file path, no dependency key, no SQL.
- Every sentence is a behaviour a test in this epic asserts.

## Verify

```
node --test test/helpers/proposal.test.ts
```

Add each case to `test/helpers/proposal.test.ts`, the suite that already reads documents under
`docs/proposal/` and asserts their content, and which EPIC 050 Story 7 (`07-the-proposal-records-the-run-model`) and
EPIC 050.1 Story 9 (`09-the-proposal-records-the-claim`) also extend for this document.

1. `"the proposal states the five authority conditions"` — assert the section exists and names all six refusal codes, built by importing `runAuthorityRefusals` from `src/domain/run-authority.ts` rather than restating six literals, so the document and the code cannot drift.
2. `"the proposal states the renew formula and the lifetime boundary"` — assert the document holds `min(now + runTtlMs, max_lifetime_at)` and `now >= max_lifetime_at`.
3. `"the proposal states one terminal event per run"` — assert the document names `run.ended` and `run.expired` and the words `never both and never neither`.
4. `"the proposal binds a write to the run of its node"` — assert the document holds `the run's own node` and states that the subtree rule governs exclusion and not authority.
5. `"the proposal states that a lease fence and a run fence are two counters"` — assert the document names all four claim response values and the sentence that a write presents the run fence of the run it names.
6. `"the proposal states that a task renew moves two runs"` — assert the document names the objective run renewal at the renew and at the claim, and the per-run clamp to `max_lifetime_at`.

`pnpm run verify` exits 0. It reads `docs/proposal/` for the parity and error-table comparisons, so a
drift between this document and the contract fails there.

Proof: PASS line delivered — `test/helpers/proposal.test.ts` in `PASS EPIC-050.2`.
