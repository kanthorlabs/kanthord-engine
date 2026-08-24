# Story 3 — The structural edit at `ready`

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: Story 2. The flip is unreachable while a structural edit is refused at `ready`.

## Change

### `docs/proposal/phase-1/plan-format.md:109`

The row reads today:

```
| `ready`, structural                                                                                | `database`  | illegal                                |
```

Change the `Suggestion` cell to `` `submitted` `` and the `The other choice` cell to `legal`. Keep the `Case` cell byte-identical. Keep the column padding of the table consistent with the surrounding rows. Line 107 and line 108 stay word for word.

### `src/domain/plan-choice.ts:91`

The branch reads today:

```ts
  if (facts.state === "pending" || facts.state === "blocked") {
```

It becomes:

```ts
  if (
    facts.state === "pending" ||
    facts.state === "blocked" ||
    facts.state === "ready"
  ) {
```

### `src/domain/plan-choice.ts:109`

The reason string becomes exactly `"a structural edit needs pending, blocked or ready"`.

### Nothing else in `src/domain/plan-choice.ts` changes

- The `containmentMovable` guard at `src/domain/plan-choice.ts:86-89` is unchanged, so a `ready` node whose subtree holds a lease, a workspace or a commit still refuses a `parent` or `repo` move.
- The prose branch at `src/domain/plan-choice.ts:80-82` already suggests `submitted` at `ready` and is unchanged.

### `src/domain/plan-choice.test.ts`

- Rewrite the test at `src/domain/plan-choice.test.ts:127-144`. Rename it `"ready accepts a structural change"`. Keep the same input (`presence: "both"`, `state: "ready"`, `fields: ["parent"]`, `containmentMovable: true`) and change the expected verdict to `{ suggested: "submitted", submitted: { legal: true, reason: null }, database: { legal: true, reason: null } }`.
- Change the reason literal at `src/domain/plan-choice.test.ts:172` and `:207` to `"a structural edit needs pending, blocked or ready"`. Those two tests cover `running` and `done` and keep their `legal: false` expectation.
- Change the `structural.ready` row at `src/domain/plan-choice.test.ts:232` from `{ suggested: "database", legal: false }` to `{ suggested: "submitted", legal: true }`. Change no other row of either table.
- Add one test, `it("ready refuses a parent or repo move while a node or descendant is contained", ...)`. For `fields: ["parent"]` and again for `fields: ["repo"]`, with `presence: "both"`, `state: "ready"` and `containmentMovable: false`, assert the verdict deep-equals `{ suggested: "database", submitted: { legal: false, reason: "the node or a descendant holds a lease, a workspace or a commit" }, database: { legal: true, reason: null } }`.
- Add to the same test: `fields: ["parent"]`, `state: "ready"`, `containmentMovable: true` gives `submitted` of `{ legal: true, reason: null }`.

## Constraints

- `choiceVerdict` has two production callers: `src/queries/plan/validate-plan.ts:214` and `src/commands/plan/import-plan.ts:308`. A `ready` node with a structural change now suggests `submitted` in both. Run both suites and repair only an expectation that this flip made stale. Change no production line in either caller.
- Add no new reason string. The file holds exactly five reason values after this change, at `src/domain/plan-choice.ts:51`, `:60`, `:67`, `:99` and `:109`.
- The two `Record<NodeState, ...>` tables at `src/domain/plan-choice.test.ts:215-238` stay total over `nodeStates`. Add no row and remove none.

## Verify

- `node --test src/domain/plan-choice.test.ts` exits 0.
- `node --test src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts` exits 0.
- `choiceVerdict` returns `suggested: "submitted"` and `submitted.legal: true` for `presence: "both"`, `state: "ready"`, a structural field and `containmentMovable: true`.
- `choiceVerdict` returns `submitted.legal: false` for the same node with `containmentMovable: false`, so the lease guard is asserted to survive the flip.
- The table driver at `src/domain/plan-choice.test.ts:239-272` asserts all eight states for both a prose and a structural probe, so no other state changed verdict.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `choiceVerdict` bullet at `.agents/plan/epics/014-external-drive-contract.md:81`.
