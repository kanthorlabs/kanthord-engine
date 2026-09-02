# Story 7 — Containment stops reading the lease

Epic: `.agents/plan/epics/050.3-the-plan-write-guard.md`
Depends on: Story 3 (`update-node` stops pushing the `lease` blocker), Story 6 (the import guard).
Kind: story-foundation

This story changes one pure function. It draws no path: `containmentMovable` is a domain call, and a
domain call is invisible at the seam the recorder wraps.

## Change

**`src/domain/plan-containment.ts` — drop one conjunct.**

```ts
export function containmentMovable(
  kind: NodeKind,
  facts: ContainmentFacts,
): boolean {
  return !facts.workspace && !facts.attemptCommit && !facts.retainedCommit;
}
```

The signature does not change. Its three callers — `update-node.ts:178`, `import-plan.ts:320` and
`src/queries/plan/validate-plan.ts:230` — pass the same `ContainmentFacts`, and the run guard is a
separate refusal ahead of the two write callers, so no caller changes shape.

**The third caller is the `plan.validate` report, and it gains no run guard.** `validate-plan.ts:230`
feeds `choiceVerdict`, so this one line changes that query's answer as well: a node holding a live
node lease and no run reports `containmentMovable: true` and `suggested: "submitted"` where it
reported `suggested: "database"`. The query reads no run, because a run is transient and a verdict
that flipped between two reads of one revision would be a worse contract than a write that refuses.
A caller can therefore see `plan.validate` admit a document and the import refuse it `subtree-busy`,
which is the relation `stale-revision` already has to that query. Case 6 asserts the changed verdict.

**Do not add a run to this function.** A movable-containment rule that also consulted a run would
answer two questions with one boolean and would lose the run id the refusal must name. The run guard
returns a refusal object; this function returns a verdict about execution bindings.

**`ContainmentFacts.lease` stays.** It is still produced by `readContainmentFacts` at
`src/services/plan/sqlite.ts:278` and `readSubtreeContainmentFacts` at `:308`, and nothing reads it
once this story and Story 3 land. EPIC 050.5 Story 5 deletes the field with `leaseHeld`, the private
method that computes it. Deleting it here would force the store change into this epic and split one
mechanism removal across two.

The unread interval is deliberate, and this story asserts it rather than leaving it to be noticed.

## Constraints

- Change one file. `ContainmentFacts` keeps all four members.
- Keep the `kind` parameter, unused as it already is, so no caller changes.
- Do not touch `readContainmentFacts` or `readSubtreeContainmentFacts`.
- Do not add a run parameter, a run field or a run read.

## Verify

```
node --test src/domain/plan-containment.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/validate-plan.test.ts
```

Add, each as a separate `it`:

1. `"a live lease no longer blocks a containment move"` — `{ lease: true, workspace: false, attemptCommit: false, retainedCommit: false }` returns `true`, asserted by value. This is the behaviour the epic deliberately relaxes.

2. `"a workspace still blocks"` — `{ lease: false, workspace: true, ... }` returns `false`.

3. `"an attempt commit still blocks"`.

4. `"a retained commit still blocks"`.

Cases 2 to 4 with case 1 prove the drop is exactly one conjunct.

5. `"an import moving a node holding an orphan lease is admitted"` — in `src/commands/plan/import-plan.test.ts`, seed a live node lease on `T` with `seedLeaseOnNode` at `test/helpers/rows.ts:668` and no run, submit a document moving `T` to a new parent, and assert the move is legal.

6. `"plan.validate suggests the submitted document for a node holding an orphan lease"` — in `src/queries/plan/validate-plan.test.ts`, the same fixture, and assert the choice carries `containmentMovable: true` and `suggested: "submitted"` by value. `containmentMovable` has **three** callers — `update-node.ts:178`, `import-plan.ts:320` and `validate-plan.ts:230` — and Story 3 asserts only the first. All three are relaxed by this one-line change, and all three are asserted.

7. `"ContainmentFacts.lease is read by no production file"` — a tree assertion, not a single grep: enumerate every file under `src/` that is not a test, and assert none matches `facts.lease` or `.lease` on a `ContainmentFacts` value. The producer survives on purpose, and this assertion is what makes that interval safe. Write it in `src/domain/plan-containment.test.ts`, beside the four unit cases above.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/plan-containment.test.ts` in `PASS EPIC-050.3`.
