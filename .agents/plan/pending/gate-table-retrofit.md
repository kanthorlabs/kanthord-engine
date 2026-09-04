# The gate list becomes a table in four epics

**The obligation.** `.agents/plan/authoring.md` states that the hermetic coverage list of
`## Verification Gate` is a table, and that every row names exactly one proof owner. **No mechanism
enforces it.** That refusal is bullet 25 of `.agents/plan/authoring.md:399`, and
`scripts/verify-epic-sequence.ts` was built before the bullet was written and never gained it. EPIC
058 builds it. Until then this obligation is a convention, and nothing goes red when an epic breaks
it.

Twenty-two epics of the EPIC 050 to EPIC 057 family satisfy the form. Four do not, and each holds a
bullet list instead. Measured 2026-09-04:

| epic  | gate list  | proof owner named |
| ----- | ---------- | ----------------- |
| 050   | 9 bullets  | one per bullet    |
| 050.1 | 31 bullets | one per bullet    |
| 054   | 25 bullets | none              |
| 057   | 16 bullets | none              |

EPIC 050 and EPIC 050.1 already name an owner per bullet, so those two are a form change. EPIC 054
and EPIC 057 name no owner at all, so each row needs a proof owner decided before it is written.

**Two table shapes are in use, and both are valid.** EPIC 050.2 and EPIC 050.3 head their tables
`| assertion | story |`; every later epic heads them `| # | assertion | story |`. Bullet 25 keys on
the `story` column and never on a `#` column, or it refuses forty-nine correct rows of EPIC 050.2
and forty-seven of EPIC 050.3.

**Only EPIC 050 and EPIC 050.1 are in the gate's range.** `authoredEpics` of
`scripts/epic-sequence-range.ts` ends at `"052.2"`, so EPIC 054 and EPIC 057 are grandfathered until
the epic that authors each adds its id. The change that builds bullet 25 converts the two in range;
EPIC 054 and EPIC 057 wait for the epic that admits each to the range.

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
against the finished table, in both directions, and budget all four for each of the four that remain.

**The owner.** Ulrich, per epic. A form change is mechanical; deciding the proof owner of an unowned
row is not, and `.agents/plan/authoring.md` refuses a gate assertion owned by no story or by two.

**The trigger.** The change that builds bullet 25 and wires
`scripts/verify-epic-sequence.ts` into the `verify` script of `package.json`. Two earlier statements
named a specific epic and both were wrong:
`.agents/plan/stories/050.1-the-claim/08-the-range-gate.md` deferred the wiring to the last story of
EPIC 050.5, and this document named EPIC 057. Neither can hold, because
`.agents/plan/authoring.md` lets only the change that makes the range clean wire the gate.

**What breaks if the answer arrives late.** EPIC 050 and EPIC 050.1 are the two in the gate's range,
so `pnpm run verify` fails on those two the moment bullet 25 and the wiring land together. Both are
converted in the same change for that reason. EPIC 054 and EPIC 057 break nothing until the epic that
authors each adds its id to `authoredEpics`.

**This document previously claimed the gate already refuses a non-table list. It does not.** Bullet
25 was written into `.agents/plan/authoring.md` by commit `bf633f5` and never implemented, so the
risk this entry recorded could not fire. The claim is corrected here rather than deleted, because it
is the reason the entry understated its own urgency for two days.

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
