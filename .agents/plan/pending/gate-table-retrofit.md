# The gate list becomes a table in six epics of the range

**The obligation.** `.agents/plan/authoring.md` now states that the hermetic coverage list of
`## Verification Gate` is a table, and that every row names exactly one proof owner. The gate refuses
any other form. Nine epics satisfy it today: EPIC 050.2, EPIC 050.3, EPIC 050.4, EPIC 050.5 and the five epics of
the EPIC 051 family. Four do not, and each holds a bullet list instead:

| epic  | gate bullets | rows naming a story |
| ----- | ------------ | ------------------- |
| 050   | 9            | 9                   |
| 050.1 | 30           | 30                  |
| 051   | done         | 25                  |
| 051.1 | done         | 25                  |
| 051.2 | done         | 14                  |
| 051.3 | done         | 24                  |
| 051.4 | done         | 23                  |
| 052   | 18           | 0                   |
| 053   | 14           | 0                   |
| 054   | 18           | 0                   |
| 055   | 17           | 0                   |
| 056   | 17           | 0                   |
| 057   | 16           | 0                   |

EPIC 050 and EPIC 050.1 already name an owner per bullet, so those two are a form change. EPIC 052 to
EPIC 057 name no owner at all, so each row needs a proof owner decided before it is written.

**What the EPIC 050.2 conversion taught, on 2026-09-02.** Twenty-four bullets became forty-eight
rows, and the same three effects appeared. One bullet stated nine cases over three commands and
became three rows; one stated two assertions over two commands and became two rows; two bullets each
named two owners and split. The conversion also carried four rows the bullets did not hold, because
the epic had just taken a ruling on refusal precedence that no bullet covered.

**What the EPIC 050.3 conversion taught, on 2026-09-02.** The form change is not one row per bullet.
Six of its twenty-four bullets stated one assertion over five commands — "one case per command, five
commands" — and a row may name only one proof owner, so each of those became one row per command.
Twenty-four bullets became forty-six rows. Three further effects: an assertion cell may not name a
story, because a gate that counts story references in a row would see two, so every "Story 1 owns
this case" moved into the story column; the split exposed one gate assertion no story held, an
ended-run boundary for `node.update`, which the conversion added as a case rather than dropping the
row; and it exposed the reverse, a decision with no assertion at all — `create-node` seeds nothing
for an initiative — which became a forty-seventh row on Ulrich's ruling. The table is the contract
for what proves the epic, so a decision missing from it makes its case deletable. Read `## Decisions`
against the finished table, in both directions, and budget all four for each of the six that remain.

**The owner.** Ulrich, per epic. A form change is mechanical; deciding the proof owner of an unowned
row is not, and `.agents/plan/authoring.md` refuses a gate assertion owned by no story or by two.

**The trigger.** `scripts/verify-epic-sequence.ts` entering the `verify` script of `package.json`.
`.agents/plan/stories/050.1-the-claim/08-the-range-gate.md` builds the script in EPIC 050.1 and defers
that wiring to the change that completes the last story of the range. The range is EPIC 050 to
EPIC 057, so EPIC 057 is the change that pulls the trigger.

**What breaks if the answer arrives late.** The gate refuses a non-table gate list, so `pnpm run verify`
fails on six epics the moment the wiring lands. The wiring change then either merges a red gate,
which `.agents/plan/authoring.md` refuses, or reverts, which leaves the range unenforced.

**Why the refusal was written before the retrofit.** The measurement that forced it: six epics of one
family used four syntaxes for one obligation, and the single gate assertion of EPIC 050.2 that no
story could satisfy hid inside twenty-four bullets that named no owner. A rule with no mechanism is a
rule a reviewer applies inconsistently, so the mechanism is specified first and this document carries
the debt it creates.

**EPIC 051 is done, and it is the fifth measurement.** The split into EPIC 051, EPIC 051.1, EPIC 051.2,
EPIC 051.3 and EPIC 051.4 on 2026-09-03 rewrote its gate as five tables. Fifty bullets became one
hundred and eleven rows, and the same three effects appeared again: a bullet stating one assertion
over several commands became one row per command; two bullets each named two owners and split; and
the split exposed four assertions no bullet held — the `git_operation` rebuild controls of migration
`13`, the loser's `objective-busy` refusal, the `PRAGMA` restoration, and the control that
EPIC 051.4 retires no capability. The retrofit's own count of thirty bullets for EPIC 051 was wrong: the file held
fifty.
