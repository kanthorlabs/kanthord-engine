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

The signature does not change. Its callers — `update-node.ts:184` and `import-plan.ts:316` — pass the
same `ContainmentFacts`, and the run guard is a separate refusal ahead of both, so no caller changes
shape.

**Do not add a run to this function.** A movable-containment rule that also consulted a run would
answer two questions with one boolean and would lose the run id the refusal must name. The run guard
returns a refusal object; this function returns a verdict about execution bindings.

**`ContainmentFacts.lease` stays.** It is still produced by `readContainmentFacts` at
`src/services/plan/sqlite.ts:276` and `readSubtreeContainmentFacts` at `:306`, and nothing reads it
once this story and Story 3 land. EPIC 050.4 deletes the field with `leaseHeld`, the private method
that computes it. Deleting it here would force the store change into this epic and split one
mechanism removal across two.

The unread interval is deliberate, and this story asserts it rather than leaving it to be noticed.

## Constraints

- Change one file. `ContainmentFacts` keeps all four members.
- Keep the `kind` parameter, unused as it already is, so no caller changes.
- Do not touch `readContainmentFacts` or `readSubtreeContainmentFacts`.
- Do not add a run parameter, a run field or a run read.

## Verify

```
node --test src/domain/plan-containment.test.ts
```

Add, each as a separate `it`:

1. `"a live lease no longer blocks a containment move"` — `{ lease: true, workspace: false, attemptCommit: false, retainedCommit: false }` returns `true`, asserted by value. This is the behaviour the epic deliberately relaxes.

2. `"a workspace still blocks"` — `{ lease: false, workspace: true, ... }` returns `false`.

3. `"an attempt commit still blocks"`.

4. `"a retained commit still blocks"`.

Cases 2 to 4 with case 1 prove the drop is exactly one conjunct.

5. `"an import moving a node holding an orphan lease is admitted"` — in `src/commands/plan/import-plan.test.ts`, seed a live node lease on `T` with no run, submit a document moving `T` to a new parent, and assert the move is legal. `containmentMovable` has **two** callers — `update-node.ts:184` and `import-plan.ts:316` — and Story 3 asserts only the first. Both are relaxed by this one-line change, and both are asserted.

6. `"ContainmentFacts.lease is read by no production file"` — a tree assertion, not a single grep: enumerate every file under `src/` that is not a test, and assert none matches `facts.lease` or `.lease` on a `ContainmentFacts` value. The producer survives on purpose, and this assertion is what makes that interval safe. Place it beside the existing tree assertions rather than inside this unit file if the harness already holds one.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/plan-containment.test.ts` in `PASS EPIC-050.3`.
