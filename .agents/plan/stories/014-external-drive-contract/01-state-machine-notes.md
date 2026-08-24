# Story 1 — The state-machine note amendment

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order).

Every exact string below is a fenced block, because these strings contain backticks and `prettier` rewrites an inline code span that holds them. Copy each block verbatim, and never retype one.

## Change

Amend five notes and three aggregation cells in `docs/proposal/phase-1/state-machine.md`, then mirror the five notes in `src/domain/transition.ts`. Do not touch `state-machine.md:47`; Story 10 owns that line.

### Aggregation table, line 39, the Task row

The `Reaches done` cell reads:

```text
verification passes and `re@1` accepts
```

Replace that cell text with exactly:

```text
internal: verification passes and `re@1` accepts. external: the harness reports an accepted outcome
```

### Aggregation table, line 40, the Objective row

The `Reaches done` cell reads:

```text
integration succeeds and every task is `done`
```

Replace that cell text with exactly:

```text
internal: integration succeeds and every task is `done`. external: a `human` actor closes the attested objective and every task is `done`
```

The `Reaches partial` cell reads:

```text
integration succeeds and at least one task is `discarded`
```

Replace that cell text with exactly:

```text
internal: integration succeeds and at least one task is `discarded`. external: a `human` actor closes the attested objective and at least one task is `discarded`
```

Change no other cell of the table. The column order stays `Level`, `Reaches awaiting_approval`, `Reaches done`, `Reaches partial`, `Reaches discarded`. Keep every row on one line.

### Matrix notes

Change the `Note` column only. Keep the `From`, `To`, `T`, `O` and `I` cells of each row byte-identical.

Line 78, `running` to `ready`. The note becomes exactly:

```text
T: recovery finds an expired lease, a clean tree, and the head at the base, or an external harness reports a rejected attempt under the attempt limit, which ends the attempt and returns the task to the pool. O and I: no operation rewinds a running parent to a claimable state.
```

Line 80, `running` to `awaiting_approval`. The note becomes exactly:

```text
O: every task is terminal, and at least one task is `done`. An externally driven objective reaches the state on an explicit attestation by its lease holder, which carries the combined object id in place of a frozen candidate. T and I: the gate is objective only.
```

Line 81, `running` to `done`. The note becomes exactly:

```text
T: `re@1` accepts the diff. An externally driven task reaches `done` when the harness reports an accepted outcome, because the external drive holds no `re@1` and no verify. I: every objective is `done`, and the end-to-end check passed or recorded `not-applicable`. O: an objective always passes the human gate.
```

Line 95, `awaiting_approval` to `done`. The note becomes exactly:

```text
O: a human approved the frozen candidate, integration succeeded, and every task is `done`. An externally driven objective closes on a `human` actor decision with no integration.
```

Line 96, `awaiting_approval` to `partial`. The note becomes exactly:

```text
O: as `done`, and the approval carried `acknowledge_partial`. An externally driven objective closes on a `human` actor decision with no integration.
```

### `src/domain/transition.ts`

Five `note` strings change, and nothing else in the file changes. Each string becomes byte-identical to the document note above.

- `src/domain/transition.ts:140`, the `from: "running"` / `to: "ready"` row. Take the line 78 note.
- `src/domain/transition.ts:156`, the `from: "running"` / `to: "awaiting_approval"` row. Take the line 80 note.
- `src/domain/transition.ts:164`, the `from: "running"` / `to: "done"` row. Take the line 81 note.
- `src/domain/transition.ts:276`, the `from: "awaiting_approval"` / `to: "done"` row. Take the line 95 note.
- `src/domain/transition.ts:284`, the `from: "awaiting_approval"` / `to: "partial"` row. Take the line 96 note.

## Constraints

- Change no `task`, `objective` or `initiative` boolean in `src/domain/transition.ts`. Story 2 owns the one boolean flip.
- Change no row order and add no row. `transitions.length` stays 56.
- Do not edit `state-machine.md:47`. Story 10 owns it.
- No test reads `state-machine.md` prose today. This story adds the parity test that closes the gap.

## Verify

**Add the matrix parity test.** It is the mechanism for this story and for Story 2, and it makes the document the oracle instead of a duplicated literal. Add it to `src/domain/transition.test.ts` inside the existing `describe("src/domain/transition.test", ...)`, as `it("every matrix row of state-machine.md equals its transitions row", ...)`. `src/domain/state.test.ts:60-77` is the precedent for a domain test that reads a proposal document, and `eslint.config.js:233` exempts a test file from the domain import ban, so `node:fs` and `node:path` are legal here.

Parse it exactly this way:

- Read `docs/proposal/phase-1/state-machine.md` with `readFileSync(resolve(import.meta.dirname, "../../docs/proposal/phase-1/state-machine.md"), "utf-8")` and split on a newline.
- Keep a line only when it starts with a pipe. Split it on the pipe, drop the first and last elements, and trim each remaining cell. Keep the line only when exactly six cells remain and both the first and the second cell are a single backticked lowercase name, matched by `/^`([a-z_]+)`$/`.
- That yields exactly **36** rows today. Assert the count is 36, so a dropped or malformed row fails rather than silently shrinking the oracle.
- For each parsed row, find the `transitions` entry whose `from` and `to` equal the two captured states. Assert it exists.
- Assert `row.note` equals the sixth cell exactly.
- Assert the mark cells: the third cell equals `row.task ? "✅" : "❌"`, the fourth the same over `row.objective`, and the fifth the same over `row.initiative`.

Verified against the current tree: all 36 rows already agree on the note and on all three marks, so the test is green before this story edits anything, and it turns red the moment a document note and a code note drift apart.

- Add a second test, `it("five notes name the external trigger", ...)`: for each of the five ordered pairs `running`/`ready`, `running`/`awaiting_approval`, `running`/`done`, `awaiting_approval`/`done` and `awaiting_approval`/`partial`, assert the `transitions` row note contains the substring `external`.
- The three amended aggregation cells at lines 39 and 40 carry no code counterpart and therefore no parity test. Assert them by inspection, with these two commands:

```bash
grep -n "external: the harness reports an accepted outcome" docs/proposal/phase-1/state-machine.md
grep -c "actor closes the attested objective" docs/proposal/phase-1/state-machine.md
```

The first returns line 39. The second returns 2.

- `node --test src/domain/transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014` through `src/domain/*.test.ts`.
