# Story 5 — The plan store stops computing the lease facts

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: nothing in this epic. EPIC 050.3 Story 3 (`03-the-update-node-guard`) and Story 7 removed the last two readers of `ContainmentFacts.lease`.
Kind: story-foundation

This story changes one store method and two of its callers. It draws no path: `leaseHeld` is
**private** at `src/services/plan/sqlite.ts:564`, reached only from `readContainmentFacts` at `:278`
and `readSubtreeContainmentFacts` at `:308`. No command calls it, so no command's seam trace changes
when it dies.

## Change

**`src/services/plan/sqlite.ts` — delete three lease reaches.**

**1 — the private method.** Delete `leaseHeld` at `:564-573` whole.

**2 — the two `ContainmentFacts` producers.** Delete the `lease:` member from the object returned by
`readContainmentFacts` at `:278` and by `readSubtreeContainmentFacts` at `:308`. Delete `lease` from
the `ContainmentFacts` type in `src/services/plan/index.ts`, leaving `workspace`, `attemptCommit` and
`retainedCommit`.

**3 — the subtree blocker.** Delete the `{ blocker: "lease", sql: ... }` entry at `:351-356` from the
`queries` list of `readSubtreeExecutionFacts`, and delete `"lease"` from `executionBlockers` at
`src/domain/plan-graph.ts:38-46`, which is the closed list `SubtreeExecutionFact["blocker"]` derives
from. **The list keeps six members**: `workspace`, `run`, `attempt`, `commit`, `check-result` and
`git-operation`, in that order. The two the shipped `queries` list carries beyond the first four —
`check-result` at `:375-378` and `git-operation` at `:379-382` — are untouched.

**The `run` blocker at `:361-364` is shipped and it stays.** It matches any run row on a subtree node,
not only an active one, which is wider than the `lease` member it now replaces. This story does not
narrow it: `delete-node`'s `binding-in-use` refusal is about a node that is bound to execution
history, and a finished run is such a binding. EPIC 050.3 Story 4 (`04-the-delete-node-guard`) drew that path and left both
members; this story removes one.

**No wire schema moves.** `src/http/contract/error-details.ts:36` types the blocker as
`blocker: z.string()`, so the closed union is a TypeScript type and not an emitted enum.

**`containmentMovable` is not touched.** EPIC 050.3 Story 7 (`07-containment-stops-reading-the-lease`) already dropped its `!facts.lease`
conjunct, and it takes `ContainmentFacts` by type, so removing the field is a type-level change its
body does not see.

**One string it feeds is touched.** `src/domain/plan-choice.ts:97` returns the containment refusal
reason `"the node or a descendant holds a lease, a workspace or a commit"`. The lease left that
predicate at EPIC 050.3 Story 7 (`07-containment-stops-reading-the-lease`) and its last producer dies here, so change the string to
`"the node or a descendant holds a workspace or a commit"`. It is asserted verbatim at
`src/domain/plan-choice.test.ts:157,321,337`, so those three sites move in the same edit.
`src/cli/plan/import.test.ts:509,513` hold a shorter hand-written fixture reason,
`"the node or a descendant holds a lease"`, which no production file produces; amend it to
`"the node or a descendant holds a workspace"` so no fixture advertises a removed mechanism.

## Constraints

- Delete exactly one member of the blocker list. Do not touch `workspace`, `run`, `attempt` or `commit`.
- Do not narrow the `run` blocker to active runs. That is a behaviour change no story in this epic asked for.
- Do not touch `containmentMovable` or `src/domain/plan-containment.ts`.
- Do not touch the `lease` table. It survives this epic, empty, until EPIC 057's migration `18`.

## Verify

```
node --test src/services/plan/sqlite.test.ts src/commands/node/delete-node.test.ts src/commands/node/update-node.test.ts src/commands/plan/import-plan.test.ts src/domain/plan-choice.test.ts src/cli/plan/import.test.ts
```

Add, each as a separate `it`:

1. `"ContainmentFacts holds exactly workspace, attemptCommit and retainedCommit"` — assert the key set of `readContainmentFacts`' return by value, and the same for `readSubtreeContainmentFacts`. Two assertions, one case, so one producer cannot keep the field while the other loses it.

2. `"executionBlockers is workspace, run, attempt, commit, check-result and git-operation"` — assert the exported array by value. Six members, in order, so the deletion is exactly one and the `check-result` and `git-operation` members cannot be lost with it.

2b. `"readSubtreeExecutionFacts returns a blocker per binding"` — seed a node holding a workspace, a run, an attempt, a candidate, a check result and a git operation, and assert the returned `blocker` values, sorted, deep-equal the six.

3. `"a live lease row produces no blocker"` — seed an unexpired lease row on a node with no other binding by raw SQL, `('node', T, 'daemon_test', 'daemon', 1, NOW, NOW, NOW + 300000)`, and assert `readSubtreeExecutionFacts` returns an empty list. `test/helpers/rows.ts:668 seedLeaseOnNode` writes `expires_at: 2` and cannot express a live lease. The table still exists after this epic, so the row is real and this assertion stays green through EPIC 057.

3b. `"the containment refusal reason names no lease"` — assert the `plan-choice` reason string by value, and assert the CLI import fixture holds no `lease` substring.

4. `"delete-node still refuses binding-in-use on a run row"` — seed a run and assert `blockers` deep-equals `[{ nodeId: T, blocker: "run" }]`.

5. `"delete-node no longer refuses on a lease row"` — seed only a lease row on `T` and assert the delete succeeds. With case 4 the drop is exactly one member.

6. `"update-node and import-plan are unaffected"` — carry the shipped containment cases across unchanged. EPIC 050.3 already stopped both from reading the field, and this case is the guard that the type-level removal reached neither body.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` in `PASS EPIC-050.5`.
