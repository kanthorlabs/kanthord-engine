# The gate list becomes a table in eleven epics of the range

**The obligation.** `.agents/plan/authoring.md` now states that the hermetic coverage list of
`## Verification Gate` is a table, and that every row names exactly one proof owner. The gate refuses
any other form. Two epics satisfy it today: EPIC 050.4 and EPIC 050.5. Eleven do not, and each holds
a bullet list instead:

| epic  | gate bullets | rows naming a story |
| ----- | ------------ | ------------------- |
| 050   | 9            | 9                   |
| 050.1 | 30           | 30                  |
| 050.2 | 24           | 24                  |
| 050.3 | 27           | 27                  |
| 051   | 30           | 0                   |
| 052   | 18           | 0                   |
| 053   | 14           | 0                   |
| 054   | 18           | 0                   |
| 055   | 17           | 0                   |
| 056   | 17           | 0                   |
| 057   | 16           | 0                   |

EPIC 050 to EPIC 050.3 already name an owner per bullet, so those four are a form change. EPIC 051 to
EPIC 057 name no owner at all, so each row needs a proof owner decided before it is written.

**The owner.** Ulrich, per epic. A form change is mechanical; deciding the proof owner of an unowned
row is not, and `.agents/plan/authoring.md` refuses a gate assertion owned by no story or by two.

**The trigger.** `scripts/verify-epic-sequence.ts` entering the `verify` script of `package.json`.
`.agents/plan/stories/050.1-the-claim/08-the-range-gate.md` builds the script in EPIC 050.1 and defers
that wiring to the change that completes the last story of the range. The range is EPIC 050 to
EPIC 057, so EPIC 057 is the change that pulls the trigger.

**What breaks if the answer arrives late.** The gate refuses a non-table gate list, so `pnpm run verify`
fails on eleven epics the moment the wiring lands. The wiring change then either merges a red gate,
which `.agents/plan/authoring.md` refuses, or reverts, which leaves the range unenforced.

**Why the refusal was written before the retrofit.** The measurement that forced it: six epics of one
family used four syntaxes for one obligation, and the single gate assertion of EPIC 050.2 that no
story could satisfy hid inside twenty-four bullets that named no owner. A rule with no mechanism is a
rule a reviewer applies inconsistently, so the mechanism is specified first and this document carries
the debt it creates.

**What is deliberately not requested.** Do not convert EPIC 051 here. Its gate rows are rewritten by
the story-tree conversion that `.agents/plan/pending/051-the-story-tree-conversion.md` tracks, and
converting the list twice moves the same rows twice.
