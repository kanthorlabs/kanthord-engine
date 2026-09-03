# The gate list becomes a table in six epics of the range

**The obligation.** `.agents/plan/authoring.md` now states that the hermetic coverage list of
`## Verification Gate` is a table, and that every row names exactly one proof owner. The gate refuses
any other form. Thirteen epics satisfy it today: EPIC 050.2, EPIC 050.3, EPIC 050.4, EPIC 050.5, the five epics of
the EPIC 051 family, EPIC 052, EPIC 052.1, EPIC 055 and EPIC 055.1. Six do not, and each holds a bullet list instead:

| epic  | gate bullets | rows naming a story |
| ----- | ------------ | ------------------- |
| 050   | 9            | 9                   |
| 050.1 | 30           | 30                  |
| 051   | done         | 25                  |
| 051.1 | done         | 25                  |
| 051.2 | done         | 14                  |
| 051.3 | done         | 24                  |
| 051.4 | done         | 23                  |
| 052   | done         | 25                  |
| 052.1 | done         | 34                  |
| 053   | 14           | 0                   |
| 054   | 18           | 0                   |
| 055   | done         | 30                  |
| 055.1 | done         | 30                  |
| 056   | 17           | 0                   |
| 057   | 16           | 0                   |

EPIC 050 and EPIC 050.1 already name an owner per bullet, so those two are a form change. EPIC 053,
EPIC 054, EPIC 056 and EPIC 057 name no owner at all, so each row needs a proof owner decided before
it is written.

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

**EPIC 052 is done, and it is the sixth measurement.** The split into EPIC 052 and EPIC 052.1 on
2026-09-03 rewrote its gate as two tables. Eighteen bullets became fifty-nine rows, and two effects
were new. First, the conversion deleted work rather than only redistributing it: three refusal codes
of the old gate — `patch-id-invalid`, `patch-hierarchy-invalid` and `patch-dependency-invalid` —
duplicated findings the shipped `validateCandidateStructural` already returns, and a fourth,
`graph-contended`, duplicated the shipped `stale-revision`, so four codes and their rows left the
document. Second, two whole stories left with them: the old Story 10 and Story 14 gave EPIC 052 the
completeness exemption that `.agents/plan/epics/050.1-the-claim.md:114` already owns. The table is
what exposed both, because a row demanding one proof owner forces the question of which epic ships
the behaviour. Six bullets also became rows the old gate did not hold at all: the two foreign-key
ordering controls of the lowering, the control that the snapshot comparison detects an injected write,
the control that the create-existing verdict is not redundant, the `blob` table in the refusal
snapshot, and the pre-raise fence on the checkpoint.

**EPIC 055 is done, and it is the seventh measurement.** The split into EPIC 055 and EPIC 055.1 on
2026-09-03 rewrote its gate as two tables. Seventeen bullets became sixty rows, and two effects were
new. First, a bullet may become a row in the **other** epic of the split: the proof owner is the story
that wires a behaviour, not the story that defines the function it calls, so every limit, scope,
expiry and end-effect bullet moved to EPIC 055.1 while the pure functions they exercise stayed in
EPIC 055. A retrofit that had kept each bullet beside its definition would have given EPIC 055 rows no
story of EPIC 055 could satisfy. Second, the conversion deleted a refusal code: `human-only-operation`
and its rows left the document, because the caller kind became registry data on `allowedActors` and
the shipped `actor-forbidden` already proves the refusal — the same effect EPIC 052 showed, reached
from the opposite direction, since here the duplicate was a code the epic proposed rather than one the
tree already had. The split also exposed assertions no bullet held: the caller-kind tuple by value,
the control that a grant id in the `Bearer` scheme is refused, the iteration proving EPIC 055 admits a
grant caller on no operation at all, the replay proving no shipped claim, report or renew trace moved,
the revocation race between authentication and the command transaction, the three-way refusal
precedence case, and the control that every shipped external run still inserts a null `grant_id`. One
decision had no assertion at all — `release` is not a granted operation — and it became a row.
