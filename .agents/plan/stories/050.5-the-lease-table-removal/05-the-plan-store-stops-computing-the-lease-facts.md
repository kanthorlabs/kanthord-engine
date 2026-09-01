# Story 5 — The plan store stops computing the lease facts

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: nothing in this epic. EPIC 050.3 Story 3 and Story 7 removed the last two readers of `ContainmentFacts.lease`.
Kind: story-foundation

This story changes one store method and two of its callers. It draws no path: `leaseHeld` is
**private** at `src/services/plan/sqlite.ts:558`, reached only from `readContainmentFacts` at `:276`
and `readSubtreeContainmentFacts` at `:306`. No command calls it, so no command's seam trace changes
when it dies.

## Change

**`src/services/plan/sqlite.ts` — delete three lease reaches.**

**1 — the private method.** Delete `leaseHeld` at `:558-567` whole.

**2 — the two `ContainmentFacts` producers.** Delete the `lease:` member from the object returned by
`readContainmentFacts` at `:276` and by `readSubtreeContainmentFacts` at `:306`. Delete `lease` from
the `ContainmentFacts` type in `src/services/plan/index.ts`, leaving `workspace`, `attemptCommit` and
`retainedCommit`.

**3 — the subtree blocker.** Delete the `{ blocker: "lease", sql: ... }` entry at `:349-353` from the
`queries` list of `readSubtreeExecutionFacts`, and delete `"lease"` from `executionBlockers` at
`src/domain/plan-graph.ts:37-45`, which is the closed list `SubtreeExecutionFact["blocker"]` derives
from. **The list keeps six members**: `workspace`, `run`, `attempt`, `commit`, `check-result` and
`git-operation`, in that order. The two the shipped `queries` list carries beyond the first four —
`check-result` at `:374-377` and `git-operation` at `:378-381` — are untouched.

**The `run` blocker at `:359-361` is shipped and it stays.** It matches any run row on a subtree node,
not only an active one, which is wider than the `lease` member it now replaces. This story does not
narrow it: `delete-node`'s `binding-in-use` refusal is about a node that is bound to execution
history, and a finished run is such a binding. EPIC 050.3 Story 4 drew that path and left both
members; this story removes one.

**No wire schema moves.** `src/http/contract/error-details.ts:36` types the blocker as
`blocker: z.string()`, so the closed union is a TypeScript type and not an emitted enum.

**`containmentMovable` is not touched.** EPIC 050.3 Story 7 already dropped its `!facts.lease`
conjunct, and it takes `ContainmentFacts` by type, so removing the field is a type-level change its
body does not see.

## Constraints

- Delete exactly one member of the blocker list. Do not touch `workspace`, `run`, `attempt` or `commit`.
- Do not narrow the `run` blocker to active runs. That is a behaviour change no story in this epic asked for.
- Do not touch `containmentMovable` or `src/domain/plan-containment.ts`.
- Do not touch the `lease` table. It survives this epic, empty, until EPIC 057's migration `17`.

## Verify

```
node --test src/services/plan/sqlite.test.ts src/commands/node/delete-node.test.ts src/commands/node/update-node.test.ts src/commands/plan/import-plan.test.ts
```

Add, each as a separate `it`:

1. `"ContainmentFacts holds exactly workspace, attemptCommit and retainedCommit"` — assert the key set of `readContainmentFacts`' return by value, and the same for `readSubtreeContainmentFacts`. Two assertions, one case, so one producer cannot keep the field while the other loses it.

2. `"executionBlockers is workspace, run, attempt, commit, check-result and git-operation"` — assert the exported array by value. Six members, in order, so the deletion is exactly one and the `check-result` and `git-operation` members cannot be lost with it.

2b. `"readSubtreeExecutionFacts returns a blocker per binding"` — seed a node holding a workspace, a run, an attempt, a candidate, a check result and a git operation, and assert the returned `blocker` values, sorted, deep-equal the six.

3. `"a live lease row produces no blocker"` — seed an owned, unexpired lease row on a node with no other binding, and assert `readSubtreeExecutionFacts` returns an empty list. The table still exists after this epic, so the row is real and this assertion stays green through EPIC 057.

4. `"delete-node still refuses binding-in-use on a run row"` — seed a run and assert `blockers` deep-equals `[{ nodeId: T, blocker: "run" }]`.

5. `"delete-node no longer refuses on a lease row"` — seed only a lease row on `T` and assert the delete succeeds. With case 4 the drop is exactly one member.

6. `"update-node and import-plan are unaffected"` — carry the shipped containment cases across unchanged. EPIC 050.3 already stopped both from reading the field, and this case is the guard that the type-level removal reached neither body.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` in `PASS EPIC-050.5`.
