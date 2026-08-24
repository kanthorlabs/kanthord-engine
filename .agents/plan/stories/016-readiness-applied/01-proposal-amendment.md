# Story 1 — The proposal amendment

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: EPIC 014 Story 1 and Story 2 (both edit the same two files, and Story 1 of EPIC 014 adds the matrix parity test that enforces this story).

## Change

Four notes change in `docs/proposal/phase-1/state-machine.md`. Three of them are matrix rows and carry a code counterpart in `src/domain/transition.ts`. Copy each string into both places byte for byte.

### `docs/proposal/phase-1/state-machine.md:63` — the `pending` → `ready` row

The `Note` cell reads today:

```
Every dependency is `done` or `partial`. The scheduler writes it.
```

Replace the cell with exactly:

```
Every dependency is `done` or `partial`. The daemon derives the transition and writes it inside the transaction of the write that changed eligibility.
```

Keep the `From`, `To`, `T`, `O` and `I` cells byte-identical. Keep the row on one line.

### `docs/proposal/phase-1/state-machine.md:85` — the `blocked` → `ready` row

The `Note` cell reads today:

```
`unblock` writes `pending`, and the scheduler re-derives readiness. A cleared node whose dependency is still discarded must not become claimable.
```

Replace the cell with exactly:

```
`unblock` writes `pending`, and the daemon re-derives readiness in the same transaction. A cleared node whose dependency is still discarded must not become claimable.
```

### `docs/proposal/phase-1/state-machine.md:86` — the `blocked` → `running` row

The `Note` cell reads today:

```
`unblock` writes `pending`, and the scheduler re-derives eligibility before any claim.
```

Replace the cell with exactly:

```
`unblock` writes `pending`, and the daemon re-derives eligibility in the same transaction, before any claim.
```

### `docs/proposal/phase-1/state-machine.md:117` — the readiness rule bullet

The bullet reads today:

```
- A node is `ready` when every dependency is `done` or `partial`. `partial` satisfies a dependency, because it shipped work and holds no error.
```

Replace it with exactly:

```
- A node is `ready` when every dependency is `done` or `partial`. `partial` satisfies a dependency, because it shipped work and holds no error. The daemon derives the state, and it writes each `pending` → `ready` and each `ready` → `pending` transition inside the transaction of the write that changed eligibility.
```

This bullet is prose and holds no code counterpart.

### `docs/proposal/phase-1/state-machine.md:11` — the `pending` row of the States table

The `Leaves by` cell reads `scheduler`. Replace the cell value with exactly:

```
daemon
```

Keep the `State` and `Meaning` cells byte-identical. The table has three columns, so the matrix parity test of EPIC 014 Story 1 — which keeps a line only when six cells remain — never reads this row. Let prettier reflow the column padding.

### `docs/proposal/phase-1/state-machine.md:19` — the writers of `pending`

The paragraph reads today:

```
Import and `unblock` are the only writers of `pending`. `unblock` clears the block reason and nothing else, and the scheduler then re-derives readiness. An abandon never returns a node to `pending`.
```

Replace it with exactly:

```
Import, `unblock` and a readiness demotion are the only writers of `pending`. `unblock` clears the block reason and nothing else, and the daemon then re-derives readiness in the same transaction. An abandon never returns a node to `pending`.
```

The sentence is false without the third writer. EPIC 014 Story 2 makes `ready` → `pending` legal at all three levels and its note at `docs/proposal/phase-1/state-machine.md:70` already names a topology write and an import as writers of that cell. This epic supplies the writer.

### `docs/proposal/phase-1/state-machine.md:27` — there is no terminal error state

The line reads today:

```
A failed task parks in `blocked`. A human clears it. The scheduler never propagates failure by itself.
```

Replace it with exactly:

```
A failed task parks in `blocked`. A human clears it. The daemon never propagates failure by itself.
```

### Line 120 stays

`docs/proposal/phase-1/state-machine.md:120` reads `Its objectives stay `ready`, the scheduler skips them`. **Do not change it.** That line is phase-2 content — it ends `See ../phase-2/integration-and-publish.md` — and a scheduler does exist there: `.agents/plan/epics/110-scheduler-leases-and-the-general-worker.md` builds it. `013-external-drive-overview.md` refuses a scheduler for the external-drive block, not for the product.

### `src/domain/transition.ts`

Three `note` strings change, and nothing else in the file changes.

- `src/domain/transition.ts:20`, the `from: "pending"` / `to: "ready"` row. Take the line 63 note.
- `src/domain/transition.ts:196`, the `from: "blocked"` / `to: "ready"` row. Take the line 85 note.
- `src/domain/transition.ts:204`, the `from: "blocked"` / `to: "running"` row. Take the line 86 note.

## Constraints

- Flip no `task`, `objective` or `initiative` boolean. EPIC 014 Story 2 owns the one flip in this block.
- Add no row and remove no row. `transitions.length` stays 56.
- Add no pair to any `allowedPairs` set in `src/domain/transition.test.ts`.
- Change no other cell of the matrix table and no other bullet of `## Rules`.
- Do not touch `docs/proposal/phase-1/state-machine.md:120`. It names the phase-2 scheduler correctly.
- Amend the wording of lines 11, 19 and 27 only. Add no sentence and delete none.
- Add no consumer and change no service.

## Verify

- `node --test src/domain/transition.test.ts` exits 0.
- The matrix parity test of EPIC 014 Story 1 passes. It parses all 36 document matrix rows and compares the sixth cell of each against the `note` of the matching `transitions` row, so a document note and a code note cannot drift. This test is the mechanism for this story; do not weaken it.
- `src/domain/transition.test.ts` still asserts `transitions.length === 56`.
- Add `it("no matrix note names the scheduler", ...)` to `describe("src/domain/transition.test", ...)`: assert `transitions.every((row) => !row.note.includes("scheduler")) === true`.
- Add `it("the pending to ready note names the daemon and the transaction", ...)`: read the `from: "pending"` / `to: "ready"` row and assert its `note` equals the line 63 string above, character for character.
- `grep -c "scheduler" docs/proposal/phase-1/state-machine.md` returns `1`. It returns `7` today. Line 120 is the one survivor, and it names the phase-2 scheduler.
- `grep -n "scheduler" docs/proposal/phase-1/state-machine.md` returns line 120 and nothing else.
- `grep -n "The daemon derives the transition and writes it inside the transaction" docs/proposal/phase-1/state-machine.md` returns line 63.
- `grep -n "Import, \`unblock\` and a readiness demotion are the only writers" docs/proposal/phase-1/state-machine.md` returns line 19.
- `grep -c "The daemon never propagates failure by itself" docs/proposal/phase-1/state-machine.md` returns `1`.
- Add `it("no phase-1 rule of state-machine.md names the scheduler outside the phase-2 reference", ...)` to `src/domain/transition.test.ts`. Read the document, split on `\n`, and assert that every line holding `scheduler` also holds `phase-2`. That is one line today. The test then fails if a later edit reintroduces the word in a phase-1 statement.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/domain/transition.test.ts`.
